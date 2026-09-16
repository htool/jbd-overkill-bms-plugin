const id = "jbd-overkill-bms-plugin";
const debug = require('debug')(id)

module.exports = function(app, options) {
  "use strict"
  var plugin = {}
  plugin.id = id
  plugin.name = "JDB / Overkill BMS readout"
  plugin.description = "Read JBD/Overkill BMS values over bluetooth"

  var unsubscribes = []
  var stopped = true
  var destroyBus = null
  var reconnectTimer = null
  var sleepResolve = null
  var deviceRef = null
  var sessionGen = 0

  var schema = {
    type: "object",
    title: "BMS settings",
    properties: {
	    batteryInstance: {
	      type: 'string',
	      title: 'Battery instance/name to use',
        default: "1"
	    },
      pollFrequency: {
        title: "Poll frequency in seconds",
        type: "number",
        default: 5
	    },
      MAC: {
        title: "BMS MAC address",
        type: "string"
      }
	  }
  }

  plugin.schema = function() {
    return schema
  }

  plugin.start = function(options, restartPlugin) {
    app.debug('Starting plugin');
    app.debug('Options: %j', JSON.stringify(options));

		const bmsMac = options.MAC
		const bmsService = '0000ff00-0000-1000-8000-00805f9b34fb'
		const bmsTx = '0000ff02-0000-1000-8000-00805f9b34fb'
		const bmsRx = '0000ff01-0000-1000-8000-00805f9b34fb'
		var request = []
		const request1 = [0xdd, 0xa5, 0x3, 0x0, 0xff, 0xfd, 0x77]
		const request2 = [0xdd, 0xa5, 0x4, 0x0, 0xff, 0xfc, 0x77]
		const pollInterval = options.pollFrequency * 500
		const START_BYTE = 0xDD
		const STOP_BYTE = 0x77
		const READ_BYTE = 0xA5
		const READ_LENGTH = 0x00
		const base = "electrical.batteries." + options.batteryInstance
		let receivedData = []

    function pushDelta(app, values) {
      var update = {
        updates: [
          { 
            values: values
          }
        ]
      }
      app.debug('update: %j', update)
      app.handleMessage(plugin.id, update)
      return
    }
		
		Buffer.prototype.toArrayInteger = function(){
		    if (this.length > 0) {
		        const data = new Array(this.length);
		        for (let i = 0; i < this.length; i=i+1)
		            data[i] = this[i];
		        return data;
		    }
		    return [];
		}

		function patchDbusNextUnhandled () {
		  // dbus-next rejects the ProxyObject method promise from the
		  // message handler. Some of those calls are internal (introspect,
		  // overlapping waitDevice, teardown) and nobody awaits them, so
		  // Signal K logs Unhandled rejection: DBusError: Not connected
		  // with the full reply object. Attaching a catch here marks the
		  // promise handled; awaited callers still see the rejection.
		  let ProxyObject
		  try {
		    ProxyObject = require('dbus-next/lib/client/proxy-object.js')
		  } catch (_e) {
		    return
		  }
		  if (!ProxyObject || !ProxyObject.prototype || ProxyObject.prototype._jbdPatched) {
		    return
		  }
		  ProxyObject.prototype._jbdPatched = true
		  const orig = ProxyObject.prototype._callMethod
		  ProxyObject.prototype._callMethod = function (iface, member, inSig, outSig, ...args) {
		    const p = orig.call(this, iface, member, inSig, outSig, ...args)
		    p.catch(err => {
		      app.debug(
		        'dbus %s %s.%s: %s',
		        this.path,
		        iface,
		        member,
		        bleErrMessage(err)
		      )
		    })
		    return p
		  }
		}

		function bleErrMessage (err) {
		  if (!err) return 'unknown BLE error'
		  return err.text || err.message || String(err)
		}

		function isDisconnectedError (err) {
		  const msg = bleErrMessage(err)
		  return /not connected|disconnected|no such object|not available/i.test(msg)
		}

		function sleep (ms) {
		  return new Promise(resolve => {
		    sleepResolve = resolve
		    reconnectTimer = setTimeout(() => {
		      reconnectTimer = null
		      sleepResolve = null
		      resolve()
		    }, ms)
		  })
		}

		async function withTimeout (promise, ms, label) {
		  let timer
		  const timeout = new Promise((_, reject) => {
		    timer = setTimeout(() => reject(new Error(label + ' timed out')), ms)
		  })
		  try {
		    return await Promise.race([promise, timeout])
		  } finally {
		    clearTimeout(timer)
		    // Timed-out BlueZ calls still settle later; swallow so they
		    // don't become Unhandled rejection: DBusError: Not connected.
		    Promise.resolve(promise).catch(() => {})
		  }
		}

		async function safeStopDiscovery (adapter) {
		  try {
		    if (adapter && await adapter.isDiscovering()) {
		      await adapter.stopDiscovery()
		    }
		  } catch (_e) {}
		}

		async function teardownSession () {
		  const device = deviceRef
		  const destroy = destroyBus
		  deviceRef = null
		  destroyBus = null
		  if (device) {
		    try {
		      await device.disconnect()
		    } catch (_e) {}
		  }
		  if (typeof destroy === 'function') {
		    try {
		      destroy()
		    } catch (_e) {}
		  }
		}

		async function openSession () {
		  const { createBluetooth } = require('node-ble')
		  patchDbusNextUnhandled()
		  const { bluetooth, destroy } = createBluetooth()
		  destroyBus = destroy
		  const adapter = await bluetooth.defaultAdapter()
		  let weStartedDiscovery = false
		  if (!await adapter.isDiscovering()) {
		    app.debug('Starting BLE discovery for %s', bmsMac)
		    await adapter.startDiscovery()
		    weStartedDiscovery = true
		  }
		  try {
		    app.debug('Waiting for BMS %s', bmsMac)
		    const device = await withTimeout(
		      adapter.waitDevice(bmsMac),
		      60000,
		      'Waiting for BMS ' + bmsMac
		    )
		    deviceRef = device
		    if (await device.isConnected()) {
		      app.debug('Dropping leftover BlueZ connection before reconnect')
		      try {
		        await device.disconnect()
		      } catch (_e) {}
		      await sleep(500)
		    }
		    app.debug('Connect...')
		    await withTimeout(device.connect(), 20000, 'Connect ' + bmsMac)
		    if (weStartedDiscovery) {
		      await safeStopDiscovery(adapter)
		      weStartedDiscovery = false
		    }
		    const gattServer = await withTimeout(
		      device.gatt(),
		      20000,
		      'GATT ' + bmsMac
		    )
		    const service1 = await gattServer.getPrimaryService(bmsService)
		    const Rx = await service1.getCharacteristic(bmsRx)
		    app.debug('Got Rx')
		    await Rx.startNotifications()
		    Rx.on('valuechanged', buffer => {
		      app.debug(buffer.toString('hex'))
		      receiveData(buffer.toArrayInteger())
		    })
		    const Tx = await service1.getCharacteristic(bmsTx)
		    app.debug('Got Tx')
		    return { adapter, device, Tx }
		  } finally {
		    if (weStartedDiscovery) {
		      await safeStopDiscovery(adapter)
		    }
		  }
		}

		async function pullData (Tx) {
		  if (stopped || !Tx) return
		  if (request == request1) {
		    request = request2
		  } else {
		    request = request1
		  }
		  // JBD TX is write-without-response; reliable writes extra ATT
		  // round-trips that BlueZ rejects with Not connected.
		  await Tx.writeValueWithoutResponse(Buffer.from(request))
		}

		async function pollUntilLost (session) {
		  await new Promise(resolve => {
		    let settled = false
		    const lost = () => {
		      if (settled) return
		      settled = true
		      resolve()
		    }
		    try {
		      session.device.on('disconnect', lost)
		    } catch (_e) {}
		    ;(async () => {
		      while (!stopped && !settled) {
		        try {
		          await pullData(session.Tx)
		        } catch (err) {
		          if (stopped) break
		          app.debug('BMS poll: %s', bleErrMessage(err))
		          if (isDisconnectedError(err)) break
		        }
		        if (stopped || settled) break
		        await sleep(pollInterval)
		      }
		      lost()
		    })().catch(lost)
		  })
		}

		async function runLoop (gen) {
		  if (!bmsMac) {
		    app.setPluginError('BMS MAC address is not set')
		    return
		  }
		  let backoff = 2000
		  while (!stopped && sessionGen === gen) {
		    try {
		      app.setPluginStatus('Connecting to BMS ' + bmsMac)
		      const session = await openSession()
		      if (stopped || sessionGen !== gen) return
		      backoff = 2000
		      app.setPluginStatus('Connected to BMS ' + bmsMac)
		      app.debug('Started notifications')
		      await pollUntilLost(session)
		      if (!stopped && sessionGen === gen) {
		        app.setPluginStatus('BMS disconnected, reconnecting')
		      }
		    } catch (err) {
		      if (!stopped && sessionGen === gen) {
		        const msg = bleErrMessage(err)
		        app.debug('BMS BLE: %s', msg)
		        app.setPluginError('BMS BLE: ' + msg)
		      }
		    } finally {
		      if (sessionGen === gen) {
		        await teardownSession()
		      }
		    }
		    if (!stopped && sessionGen === gen) {
		      await sleep(backoff)
		      backoff = Math.min(backoff * 2, 30000)
		    }
		  }
		}

		stopped = false
		const gen = ++sessionGen
		runLoop(gen).catch(err => {
		  if (!stopped && sessionGen === gen) {
		    app.debug('BMS loop died: %s', bleErrMessage(err))
		    app.setPluginError('BMS loop died: ' + bleErrMessage(err))
		  }
		})
		
		function receiveData (data) {
      // Single line
		  if (data[0] == 0xdd && data[data.length - 1] == STOP_BYTE) {
		    parseData (data)
		  } else {
        // Multi line
        if (data[0] != receivedData[0]) {
          receivedData = receivedData.concat(data)
		      if (receivedData[0] == 0xdd && receivedData[receivedData.length - 1] == STOP_BYTE) {
		        parseData (receivedData)
            while (receivedData.length > 0) {
		          receivedData.pop()
            }
          }
        } else {
          app.debug('Skipping duplicate: %j', data)
        }
      }
		}
		
		
		function parseData (rawData) {
		  // app.debug('Incoming data: %j', rawData)
		  if(validateChecksum(rawData)) {
		    app.debug('Data is valid.')
		    switch(rawData[1]) {
		      case 0x03:
		        const register3 = register0x03setData(rawData)
		        sendDelta(register3)
		        break;
		      case 0x04:
		        const register4 = register0x04setData(rawData);
		        sendDelta(register4)
		        break;
		     }
		  }
		  else {
		    app.debug('Received invalid data from BMS')
		  }
      receivedData.length = 0
		}
		
		function register0x03setData(rawData) { 
      var obj = {chemistry: 'LifePO4'}
		  //pos 4/5 Pack Voltage in 10mv, convert to V
		  obj.voltage = Number(bytesToFloat(rawData[4], rawData[5], 0.01))
		  //pos 6/7 - Pack Current, positive for chg, neg for discharge, in 10ma, convert to A
		  obj.current = Number(bytesToFloat(rawData[6], rawData[7], 0.01, true))
		  //pos 8/9 - Pack Balance Capacity, in 10mah convert to Ah
		  obj.packBalCap = Number(bytesToFloat(rawData[8], rawData[9], 0.01))
		  //pos 10/11 - Pack Rate Capacity, in 10mah, convert to Ah
		  obj.capacity = {}
		  obj.capacity.nominal = Number(bytesToFloat(rawData[10], rawData[11], 432)) // 0.01 * 3600 * 12
		  //pos 12/13 - Pack number of cycles
		  obj.chargeCycles = Number(toU16(rawData[12], rawData[13]))
		  //pos 14/15 bms production date
		      //TODO
		  //pos 25 pack cell count - do obj before balance status so we can use it to return the correct size array
		  obj.packNumberOfCells = Number(toU8(rawData[25]))
		  //pos 16/17 balance status
		  obj.balanceStatus = getBalanceStatus(rawData[16], rawData[17], obj.packNumberOfCells);
		  //pos 18/19 balance status high
		  obj.balanceStatusHigh = getBalanceStatus(rawData[18], rawData[19], obj.packNumberOfCells);
		  //pos 20/21 protection status
		  obj.protectionStatus = getProtectionStatus(rawData[20],rawData[21]);
		  //pos 22 s/w version
		  obj.bmsSWVersion = rawData[22];
		  //pos 23 RSOC (remaining pack capacity, percent)
		  obj.capacity.stateOfCharge = Number(toU8(rawData[23])) / 100
		  //pos 24 FET status, bit0 chg, bit1, dischg (0 FET off, 1 FET on)
		  obj.FETStatus = getFETStatus(rawData[24])
		  //pos 26 number of temp sensors (NTCs)
		  obj.tempSensorCount = toU8(rawData[26])
		  //pos 27 / 28 / 29 Temp sensor (NTC) values
		  obj.tempSensorValues = getNTCValues(rawData, obj.tempSensorCount)
      var totalTemp = 0
		  Object.values(obj.tempSensorValues).forEach ( temp => {
        totalTemp = totalTemp + temp
      })
		  obj.temperature = Number((totalTemp / obj.tempSensorCount).toFixed(2))
		  return obj
    }

		function register0x04setData (rawData) {
      var obj = {}
		  const cellData = rawData.slice(4,rawData.length-3)
		  let count = 0
		  for(var i = 0; i < rawData[3]; i++) { 
		      if(i == 0 || i % 2 == 0) {
		          const cellmV = `cell${count}mV`
		          const cellV = `cell${count}V`
		          obj[cellmV] = Number(toU16(cellData[i], cellData[i+1]))
		          obj[cellV] = Number(bytesToFloat(cellData[i], cellData[i+1], 0.001))
		          count++
		      }
		  }
		  return obj
		}
		
		function readRegisterPayload(register) {
		    const result = Buffer.alloc(7);
		    //Start Byte
		    result[0] = START_BYTE;
		    //Request type: 0xA5 read, 0x5A write
		    result[1] = READ_BYTE;
		    //Register to use
		    result[2] = register;
		    //Data length, 0 for reads
		    result[3] = READ_LENGTH;
		    //Checksum: 0x10000 subtract the sum of register and length, U16, 2bytes.
		    const chk = calcChecksum(register, result[3]);
		    result[4] =chk[0];
		    result[5] =chk[1];
		    //Stop Byte
		    result[6] = STOP_BYTE;
		    return result;
		}
		
		//calculates the checksum for a request/result
		function calcChecksum(sumOfData, length) {
		    const checksum = Buffer.alloc(2)
		    //Checksum is 0x10000 (65536 dec) minus the sum of the data plus its length, returned as a 2 byte array
		    checksum.writeUInt16BE(0x10000-(sumOfData+length));
		    return checksum;
		}
		
		//validates the checksum of an incoming result
		function validateChecksum(result) {
		    //Payload is between the 4th and n-3th byte (last 3 bytes are checksum and stop byte)
		    const sumOfPayload = result.slice(4, result.length-3).reduce((partial_sum, a) => partial_sum + a, 0);
		    const checksum = calcChecksum(sumOfPayload, result[3]);
		    return checksum[0] === result[result.length-3] && checksum[1] === result[result.length-2];
		}
		
		//returns a float to two decimal points for a signed/unsigned int and a multiplier
		function bytesToFloat(byte1, byte2, multiplier, signed) {
		    multiplier = multiplier === undefined || multiplier === null ? 1 : multiplier;
		    if(signed) {
		        return parseFloat(toS16(byte1, byte2) * multiplier).toFixed(2);
		    }
		    return parseFloat(toU16(byte1, byte2) * multiplier).toFixed(2);
		}
		
		//takes two bytes and returns 16bit signed int (-32768 to +32767)
		function toS16(byte1, byte2) {
		    return Buffer.from([byte1, byte2]).readInt16BE();
		}
		
		//takes two bytes and returns 16 bit unsigned int (0 to 65535)
		function toU16(byte1, byte2) {
		    return Buffer.from([byte1, byte2]).readUInt16BE();
		}
		
		//takes one byte and returns 8 bit int (0 to 255)
		function toU8(byte) {
		    return Buffer.from([byte]).readInt8();
		}
		
		function process2BytesToBin(byte1, byte2) {
		    return toU16(byte1, byte2).toString(2).padStart(16, '0');
		}
		
		function process1BytesToBin(byte) {
		    return toU8(byte).toString(2).padStart(8, '0');
		}
		
		function getFETStatus(byte) {
		    const fetBits = process1BytesToBin(byte).split("");
		    return {
		        "charging": Boolean(fetBits[0]),
		        "discharging": Boolean(fetBits[1])
		    }
		}
		
		function getBalanceStatus(byte1, byte2, numCells) {
		    const balanceBits = process2BytesToBin(byte1, byte2).split("").slice(0, numCells);
		    return balanceBits.map((bit, idx) =>{
		        const keyName = `cell${idx}`;
		        return {[keyName]: Boolean(parseInt(bit))};
		    });
		}
		
		function getProtectionStatus(byte1, byte2) {
		    const protectionBits = process2BytesToBin(byte1, byte2).split("").map(pb => {
		        pb = Boolean(parseInt(pb));
		        return pb;
		    });
		
		    //Bit definitions
		    const protectionStatus = {    
		        //bit0 - Single Cell overvolt
		        singleCellOvervolt: protectionBits[0],
		        //bit1 - Single Cell undervolt
		        singleCellUndervolt:protectionBits[1],
		        //bit2 - whole pack overvolt
		        packOvervolt:protectionBits[2],
		        //bit3 - whole pack undervolt
		        packUndervolt:protectionBits[3],
		        //bit4 - charging over temp
		        chargeOvertemp:protectionBits[4],
		        //bit5 - charging under temp
		        chargeUndertemp:protectionBits[5],
		        //bit6 - discharge over temp
		        dischargeOvertemp:protectionBits[6],
		        //bit7 - discharge under temp
		        dischargeUndertemp:protectionBits[7],
		        //bit8 - charge overcurrent
		        chargeOvercurrent:protectionBits[8],
		        //bit9 - discharge overcurrent   
		        dischargeOvercurrent:protectionBits[9],
		        //bit10 - short circut
		        shortCircut:protectionBits[10],
		        //bit11 - front-end detection ic error
		        frontEndDetectionICError:protectionBits[11],
		        //bit12 - software lock MOS
		        softwareLockMOS:protectionBits[12]
		        //bit13-15 reserved/unused
		    }
		    return protectionStatus;
		}
		
		function getNTCValues(bytes, numNTCs) {
		    let count = 0
		    let result = {}
		    for(let i = 27; i < 27+(numNTCs*2); i++) { 
		        if(i == 27 || i % 2 != 0) {
		            const ntcName = `NTC${count}`
		            //temp is in 0.1K convert to celcius
		            result[ntcName] = Number((bytesToFloat(bytes[i], bytes[i+1], 0.1) - 0).toFixed(2))
		            count++
		        }
		    }
		    return result
		}
		
		function sendDelta (obj) {
		  var updates = []
		  app.debug('sendDelta: %j', obj)
		  for (const [key, value] of Object.entries(obj)) {
		    // app.debug(value)
		    if (typeof value != 'object' && typeof value != 'function') {
		      updates.push({path: base + "." + key, value: value})
		    } else if (typeof value == 'object') {
		      for (const [key2, value2] of Object.entries(value)) {
		        // app.debug(value2)
		        if (typeof value2 != 'object') {
		          updates.push({path: base + "." + key + "." + key2, value: value2})
		        } else if (typeof value2 == 'object') {
		          for (const [key3, value3] of Object.entries(value2)) {
		            // app.debug(value3)
		            if (typeof value3 == 'string') {
		              updates.push({path: base + "." + key + "." + key2 + "." + key3, value: value3})
		            }
		          }
		        } 
		      }
		    }
		  }
		  app.debug(updates)
		  pushDelta(app, updates)
		}
		
  }
		
  plugin.stop = function() {
    app.debug("Stopping")
    stopped = true
    sessionGen++
    unsubscribes.forEach(f => f());
    unsubscribes = [];
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (sleepResolve) {
      const resolve = sleepResolve
      sleepResolve = null
      resolve()
    }
    Promise.resolve(teardownIfAny()).catch(() => {})
    app.debug("Stopped")
  }

  async function teardownIfAny () {
    const device = deviceRef
    const destroy = destroyBus
    deviceRef = null
    destroyBus = null
    if (device) {
      try {
        await device.disconnect()
      } catch (_e) {}
    }
    if (typeof destroy === 'function') {
      try {
        destroy()
      } catch (_e) {}
    }
  }

  return plugin;
};
