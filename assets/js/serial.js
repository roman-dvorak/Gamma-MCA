import { WebUSBSerialPort } from './external/webusbserial.js';
export class WebUSBSerial {
    port;
    device;
    isOpen = false;
    static deviceFilters = [{ 'vendorId': 0x0403, 'productId': 0x6015 }];
    constructor(device) {
        this.device = device;
    }
    async sendString(value) {
        let enc = new TextEncoder();
        await this.port?.send(enc.encode(value + '\n'));
    }
    buffer = new Uint8Array(102400);
    pos = 0;
    async read() {
        if (this.pos === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
            return new Uint8Array();
        }
        const ret = this.buffer.subarray(0, this.pos);
        this.pos = 0;
        return ret;
    }
    serOptions = {
        overridePortSettings: true,
        baudrate: 115200,
    };
    async open(baudRate) {
        this.serOptions.baudrate = baudRate;
        this.port = new WebUSBSerialPort(this.device, this.serOptions);
        this.pos = 0;
        this.port.connect(data => {
            this.buffer.set(data, this.pos);
            this.pos += data.length;
        }, error => {
            console.warn("Error receiving data: " + error);
            this.isOpen = false;
        });
        this.isOpen = true;
    }
    async close() {
        if (!this.isOpen)
            return;
        this.isOpen = false;
        this.port?.disconnect();
    }
    isThisPort(port) {
        return (this.device === port);
    }
    getInfo() {
        return "WebUSB";
    }
}
export class WebSerial {
    port;
    isOpen = false;
    constructor(port) {
        this.port = port;
    }
    isThisPort(port) {
        return this.port === port;
    }
    async sendString(value) {
        if (!this.isOpen)
            return;
        if (!this.port?.writable)
            throw 'Port is not writable!';
        const textEncoder = new TextEncoderStream();
        const writer = textEncoder.writable.getWriter();
        const writableStreamClosed = textEncoder.readable.pipeTo(this.port.writable);
        writer.write(value.trim() + '\n');
        await writer.close();
        await writableStreamClosed;
    }
    reader;
    async read() {
        let ret = new Uint8Array();
        if (!this.isOpen)
            return ret;
        if (this.port.readable) {
            try {
                this.reader = this.port.readable.getReader();
                try {
                    const { value, done } = await this.reader.read();
                    if (value) {
                        ret = value;
                    }
                    else {
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                }
                finally {
                    this.reader?.releaseLock();
                    this.reader = undefined;
                }
            }
            catch (err) {
                this.reader?.releaseLock();
                this.reader = undefined;
                await new Promise(resolve => setTimeout(resolve, 100));
                console.warn('Error Readnig.', err);
                return ret;
            }
        }
        else {
            await this.close();
        }
        return ret;
    }
    serOptions = { baudRate: 9600 };
    async open(baudRate) {
        this.serOptions.baudRate = baudRate;
        await this.port.open(this.serOptions);
        this.isOpen = true;
    }
    async close() {
        if (!this.isOpen)
            return;
        this.isOpen = false;
        if (this.reader)
            await this.reader?.cancel();
        await this.port?.close();
    }
    getInfo() {
        return `Id: 0x${this.port.getInfo().usbProductId?.toString(16)}`;
    }
}
export class SerialManager {
    port;
    closed;
    recording = false;
    onlyConsole = true;
    startTime = 0;
    timeDone = 0;
    static orderType = 'chron';
    static baudRate = 9600;
    consoleMemory = 1000000;
    rawConsoleData = '';
    rawData = '';
    maxHistLength = 2 ** 18 * 2 * 10;
    maxLength = 20;
    bufferPulseData = [];
    baseHist = [];
    static maxSize = 200000;
    static adcChannels = 4096;
    static eolChar = ';';
    constructor(port) {
        this.port = port;
    }
    isThisPort(port) {
        return this.port.isThisPort(port);
    }
    async sendString(value) {
        await this.port.sendString(value);
    }
    async showConsole() {
        if (this.recording)
            return;
        await this.port.open(SerialManager.baudRate);
        this.recording = true;
        this.onlyConsole = true;
        this.closed = this.readUntilClosed();
    }
    async hideConsole() {
        if (!this.recording || !this.onlyConsole)
            return;
        this.onlyConsole = false;
        this.recording = false;
        try {
            this.port.close();
        }
        catch (err) {
            console.warn('Nothing to disconnect.', err);
        }
        await this.closed;
    }
    async stopRecord() {
        if (!this.recording)
            return;
        this.recording = false;
        this.timeDone += performance.now() - this.startTime;
        try {
            await this.port.close();
        }
        catch (err) {
            console.warn('Nothing to disconnect.', err);
        }
        await this.closed;
    }
    async startRecord(resume = false) {
        if (this.recording)
            return;
        await this.port.open(SerialManager.baudRate);
        if (!resume) {
            this.flushData();
            this.clearBaseHist();
            this.timeDone = 0;
        }
        this.startTime = performance.now();
        this.recording = true;
        this.onlyConsole = false;
        this.closed = this.readUntilClosed();
    }
    async readUntilClosed() {
        while (this.port.isOpen && this.recording) {
            this.addRaw(await this.port.read());
        }
        await this.port?.close();
    }
    addRaw(uintArray) {
        const string = new TextDecoder("utf-8").decode(uintArray);
        this.rawConsoleData += string;
        if (this.rawConsoleData.length > this.consoleMemory) {
            this.rawConsoleData = this.rawConsoleData.slice(this.rawConsoleData.length - this.consoleMemory);
        }
        if (this.onlyConsole)
            return;
        if (this.bufferPulseData.length > SerialManager.maxSize) {
            console.warn('Warning: Serial buffer is saturating!');
            return;
        }
        this.rawData += string;
        if (SerialManager.orderType === 'chron') {
            const stringArr = this.rawData.split(SerialManager.eolChar);
            stringArr.pop();
            stringArr.shift();
            if (stringArr.length <= 1) {
                if (this.rawData.length > this.maxLength)
                    this.rawData = '';
                return;
            }
            else {
                for (const element of stringArr) {
                    this.rawData = this.rawData.replace(element + SerialManager.eolChar, '');
                    const trimString = element.trim();
                    if (!trimString.length || trimString.length >= this.maxLength)
                        continue;
                    const parsedInt = parseInt(trimString);
                    if (isNaN(parsedInt)) {
                        continue;
                    }
                    else {
                        if (parsedInt < 0 || parsedInt > SerialManager.adcChannels)
                            continue;
                        this.bufferPulseData.push(parsedInt);
                    }
                }
            }
        }
        else if (SerialManager.orderType === 'hist') {
            const stringArr = this.rawData.split('\r\n');
            stringArr.pop();
            if (!stringArr.length) {
                if (this.rawData.length > this.maxHistLength)
                    this.rawData = '';
                return;
            }
            else {
                for (const element of stringArr) {
                    this.rawData = this.rawData.replace(element + '\r\n', '');
                    const trimString = element.trim();
                    if (!trimString.length || trimString.length >= this.maxHistLength)
                        continue;
                    const stringHist = trimString.split(SerialManager.eolChar);
                    stringHist.pop();
                    if (stringHist.length !== SerialManager.adcChannels)
                        continue;
                    const numHist = stringHist.map(x => {
                        const parsed = parseInt(x);
                        return isNaN(parsed) ? 0 : parsed;
                    });
                    if (!this.baseHist.length) {
                        this.baseHist = numHist;
                        this.startTime = performance.now();
                        return;
                    }
                    const diffHist = numHist.map((item, index) => item - this.baseHist[index]);
                    if (!this.bufferPulseData.length)
                        this.bufferPulseData = Array(SerialManager.adcChannels).fill(0);
                    for (const index in this.bufferPulseData) {
                        this.bufferPulseData[index] += diffHist[index];
                    }
                    this.baseHist = numHist;
                }
            }
        }
    }
    flushData() {
        this.rawData = '';
        this.bufferPulseData = [];
    }
    clearBaseHist() {
        this.baseHist = [];
    }
    flushRawData() {
        this.rawConsoleData = '';
    }
    getRawData() {
        return this.rawConsoleData;
    }
    getData() {
        const copyArr = [...this.bufferPulseData];
        this.bufferPulseData = [];
        return copyArr;
    }
    getTime() {
        return (this.recording ? (performance.now() - this.startTime + this.timeDone) : this.timeDone);
    }
}
//# sourceMappingURL=serial.js.map