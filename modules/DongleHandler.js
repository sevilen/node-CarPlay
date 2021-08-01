const usb = require('usb');
const EventEmitter = require('events');
const VideoParser = require('./VideoParseWS')
const AudioParser = require('./AudioParse')
const fs = require("fs");

class DongleHandler extends EventEmitter {
    constructor({dpi=160, nightMode=0, hand=0, boxName="nodePlay", width=800, height=640, fps=20}) {
        super();
        this._usb = usb;
        this._dpi = dpi;
        this._nightMode = nightMode;
        this._hand = hand;
        this._boxName = boxName;
        this._width = width;
        this._height = height;
        this._fps = fps;
        this._device = null;
        this._assets = ["adb", "adb.pub", "helloworld0", "helloworld1", "helloworld2", "libby265n.so", "libby265n_x86.so", "libscreencap40.so", "libscreencap41.so", "libscreencap43.so", "libscreencap50.so", "libscreencap50_x86.so", "libscreencap442.so", "libscreencap422.so", "mirrorcoper.apk", "libscreencap60.so", "libscreencap70.so", "libscreencap71.so", "libscreencap80.so", "libscreencap90.so", "HWTouch.dex"]
        this._magic = "aa55aa55";
        this._magicBuff = Buffer.from(this._magic, 'hex')
        this._state = 0;
        this._interface = null;
        this._inEP = null;
        this._outEP = null;
        this._videoParser = new VideoParser(this._width, this._height, 2000, "http://localhost:8081/supersecret", this.updateState)
        this._audioParser = new AudioParser(this.updateState)
        if(this.getDevice()) {
            console.log("device connected and ready")
        } else {
            console.log("device not connected")
        }


    }

    getDevice = () => {
        if(usb.findByIds(0x1314, 0x1520)) {
            this._device = usb.findByIds(0x1314, 0x1520);
            this._device.open();
            this._device.reset(() => {})
            this._interface = this._device.interface(0);
            this._interface.claim();
            this._inEP = this._interface.endpoint(129);
            this._outEP = this._interface.endpoint(1);
            this._inEP.clearHalt((err) => {
                if(err) {
                    console.log("Error clearing inendpoint halt")
                    return false
                } else {
                    this._inEP.startPoll()
                }
            })
            this._outEP.clearHalt((err) => {
                if(err) {
                    console.log("Error clearing outendpoint halt")
                    return false
                } else {

                }
            })
            this._inEP.on('data', (data) => {
                this.deSerialise(data)
            })
            this.startUp()
            return true;
        } else {
            setTimeout(this.getDevice, 2000)
            return false
        }
    }

    startUp = async () => {
        await this.sendInt(this._dpi, "/tmp/screen_dpi")

        for(let i=0; i<this._assets.length;i++) {
            await this.readFile(this._assets[i])
        }

        await this.begin()

        await this.sendInt(0, "/tmp/night_mode");
        await this.sendInt(0, "/tmp/hand_drive_mode");
        await this.sendInt(0, "/tmp/charge_mode");
        await this.sendString(this._boxName, "/etc/box_name");

        setInterval(() => {
            this.heartBeat()
        }, 2000)
    }

    begin = async () => {
        console.log("starting projection")
        let width = Buffer.alloc(4)
        width.writeUInt32LE(this._width)
        let height = Buffer.alloc(4)
        height.writeUInt32LE(this._height)
        let fps = Buffer.alloc(4)
        fps.writeUInt32LE(this._fps)
        let format = Buffer.alloc(4)
        format.writeUInt32LE(5)
        let packetMax = Buffer.alloc(4)
        packetMax.writeUInt32LE(49125)
        let iBox = Buffer.alloc(4)
        iBox.writeUInt32LE(2)
        let phoneMode = Buffer.alloc(4)
        phoneMode.writeUInt32LE(2)
        let config = Buffer.concat([width, height, fps, format, packetMax, iBox, phoneMode])
        await this.serialise(config, 1)
    }

    sendInt = async (integer, fileName) => {
        let message = new Buffer(4);
        message.writeUInt32LE(integer)
        await this.sendFile(message, fileName)
    }

    sendString = async (string, fileName) => {
        if(string.length > 16 ) {
            console.log("string too long")
        }
        let message = Buffer.from(string, "ascii")
        await this.sendFile(message, fileName)
    }

    sendFile = async (content, fileName) => {
        let msgType = 153;
        let newFileName = this.getFileName(fileName)
        let nameLength = this.getLength(newFileName)
        let contentLength = this.getLength(content);
        let message = [nameLength, newFileName, contentLength, content]
        let fullMessage = Buffer.concat(message);
        await this.serialise(fullMessage, msgType)
    }

    serialise = async (content, msgType) => {
        return new Promise((resolve) => {
            let dataLen = this.getLength(content);
            let type = Buffer.alloc(4);
            type.writeUInt32LE(msgType);
            let typeCheck = Buffer.alloc(4);
            typeCheck.writeUInt32LE(((msgType ^ -1) & 0xffffffff)>>>0);
            let message = [this._magicBuff, dataLen, type, typeCheck]
            let msgBuff = Buffer.concat(message)

            new Promise((resolve2) => {
                this._outEP.transfer(msgBuff, (err) => {
                    resolve2()
                })
            }).then(() => {
                this._outEP.transfer(content, (err) => {
                    resolve()
                })
            })
        })


    }

    updateState = (state) => {
        this._state = state;
    }

    deSerialise = (data) => {
        let header = data.slice(0, 4)
        if(this._state ===0) {
            if((Buffer.compare(this._magicBuff, header)) === 0) {
                let type = data[8]
                if(type === 6) {
                    let length = data.readUInt32LE(4)
                    this._videoParser.setActive(length)
                } else if (type ===7) {
                    let length = data.readUInt32LE(4)
                    if(length > 16) {
                        this._audioParser.setActive(length)
                    }
                }
            }
        } else if(this._state === 1) {
            this._videoParser.addBytes(data)
        } else if(this._state === 2) {
            this._audioParser.addBytes(data)
        }
    }

    getLength = (data) => {
        let buffer = new Buffer.alloc(4);
        buffer.writeUInt32LE(Buffer.byteLength(data))
        return buffer
    }

    getFileName = (name) => {
        return Buffer.from(name + '\0', 'ascii');
    }

    readFile = async (path) => {
        let fullPath = "./assets/" + path
        let size = fs.statSync(fullPath).size
        let fileBuff = Buffer.alloc(size)

        let data = fs.readFileSync(fullPath)
        await this.sendFile(data, "/tmp/" + path,)
    }

    heartBeat = () => {
        let msgType = 170;
        let message = Buffer.from('', 'ascii')
        this.serialise(message, msgType)
    }
}

module.exports = DongleHandler;