var STM32_protocol = function() {
    this.hex;
    
    this.receive_buffer;
    
    this.bytes_to_read = 0; // ref
    this.read_callback; // ref

    this.flashing_memory_address;
    this.verify_memory_address;
    
    this.bytes_flashed;
    this.bytes_verified;

    this.verify_hex = new Array();
    
    this.upload_time_start;
    
    this.steps_executed;
    this.steps_executed_last;
    
    this.status = {
        ACK:    0x79,
        NACK:   0x1F
    };
    
    this.command = {
        get:                    0x00, // Gets the version and the allowed commands supported by the current version of the bootloader
        get_ver_r_protect_s:    0x01, // Gets the bootloader version and the Read Protection status of the Flash memory
        get_ID:                 0x02, // Gets the chip ID
        read_memory:            0x11, // Reads up to 256 bytes of memory starting from an address specified by the application
        go:                     0x21, // Jumps to user application code located in the internal Flash memory or in SRAM
        write_memory:           0x31, // Writes up to 256 bytes to the RAM or Flash memory starting from an address specified by the application
        erase:                  0x43, // Erases from one to all the Flash memory pages
        extended_erase:         0x44, // Erases from one to all the Flash memory pages using two byte addressing mode (v3.0+ usart).
        write_protect:          0x63, // Enables the write protection for some sectors
        write_unprotect:        0x73, // Disables the write protection for all Flash memory sectors
        readout_protect:        0x82, // Enables the read protection
        readout_unprotect:      0x92  // Disables the read protection
    };
    
    // Erase (x043) and Extended Erase (0x44) are exclusive. A device may support either the Erase command or the Extended Erase command but not both.
};

// no input parameters
STM32_protocol.prototype.connect = function() {
    var self = this;
    
    var selected_port = String($('div#port-picker .port select').val());
    
    if (selected_port != '0') {
        chrome.serial.connect(selected_port, {bitrate: 115200, parityBit: 'even', stopBits: 'one'}, function(openInfo) {
            connectionId = openInfo.connectionId;
            
            if (connectionId != -1) {       
                if (debug) console.log('Connection was opened with ID: ' + connectionId);
                command_log('Connection <span style="color: green">successfully</span> opened with ID: ' + connectionId);

                // we are connected, disabling connect button in the UI
                GUI.connect_lock = true;
                
                // start the upload procedure
                self.initialize();
            }
        });
    } else {
        command_log('Please select valid serial port');
    }
};

// initialize certain variables and start timers that oversee the communication
STM32_protocol.prototype.initialize = function() {
    var self = this;
    
    // reset and set some variables before we start 
    self.receive_buffer = [];
    
    self.flashing_memory_address = self.hex.extended_linear_address[0];
    self.verify_memory_address = self.hex.extended_linear_address[0];
    
    self.bytes_flashed = 0;
    self.bytes_verified = 0;

    self.verify_hex = [];
    
    self.upload_time_start = microtime();
    
    self.steps_executed = 0;
    self.steps_executed_last = 0;

    chrome.serial.onReceive.addListener(function(info) {
        self.read(info);
    });    
    
    GUI.interval_add('firmware_uploader_read', function() {
        self.process_read();
    }, 1, true);
    
    GUI.interval_add('STM32_timeout', function() {
        if (self.steps_executed > self.steps_executed_last) { // process is running
            self.steps_executed_last = self.steps_executed;
        } else {
            if (debug) console.log('STM32 - timed out, programming failed ...');
            command_log('STM32 - timed out, programming <span style="color: red">failed</span> ...');
            
            // protocol got stuck, clear timer and disconnect
            GUI.interval_remove('STM32_timeout');
            
            // exit
            self.upload_procedure(99);
        }
    }, 1000);
    
    // first step
    self.upload_procedure(1);
};

// no input parameters
// this method should be executed every 1 ms via interval timer
STM32_protocol.prototype.read = function(readInfo) {
    var self = this;
    
    // routine that fills the buffer
    var data = new Uint8Array(readInfo.data);
    
    for (var i = 0; i < data.length; i++) {
        self.receive_buffer.push(data[i]);  
    }
};

// read routine is split into 2 functions after new serial api arrived (this needs to be resolved and merged into one routine)
STM32_protocol.prototype.process_read = function() {
    var self = this;
    
    // routine that fetches data from buffer if statement is true
    if (self.receive_buffer.length >= self.bytes_to_read && self.bytes_to_read != 0) {
        var data = self.receive_buffer.slice(0, self.bytes_to_read); // bytes requested
        self.receive_buffer.splice(0, self.bytes_to_read); // remove read bytes
        
        self.bytes_to_read = 0; // reset trigger
        
        self.read_callback(data);
    }
};

// Array = array of bytes that will be send over serial
// bytes_to_read = received bytes necessary to trigger read_callback
// callback = function that will be executed after received bytes = bytes_to_read
STM32_protocol.prototype.send = function(Array, bytes_to_read, callback) {
    var bufferOut = new ArrayBuffer(Array.length);
    var bufferView = new Uint8Array(bufferOut);
    
    // set Array values inside bufferView (alternative to for loop)
    bufferView.set(Array);
    
    // update references
    this.bytes_to_read = bytes_to_read;
    this.read_callback = callback; 

    // send over the actual data
    chrome.serial.send(connectionId, bufferOut, function(writeInfo) {}); 
};

// val = single byte to be verified 
// data = response of n bytes from mcu (array)
// result = true/false
STM32_protocol.prototype.verify_response = function(val, data) {
    if (val != data[0]) {
        if (debug) console.log('STM32 Communication failed, wrong response, expected: ' + val + ' received: ' + data[0]);
        command_log('STM32 Communication <span style="color: red">Failed</span>');
        
        // disconnect
        this.upload_procedure(99);
        
        return false;
    }
    
    return true;
};

// input = 16 bit value
// result = true/false
STM32_protocol.prototype.verify_chip_signature = function(signature) {
    switch (signature) {
        case 0x412: // not tested
            if (debug) console.log('Chip recognized as F1 Low-density');
            return true;
            break;
        case 0x410:
            if (debug) console.log('Chip recognized as F1 Medium-density');
            return true;
            break;
        case 0x414: // not tested
            if (debug) console.log('Chip recognized as F1 High-density');
            return true;
            break;
        case 0x418: // not tested
            if (debug) console.log('Chip recognized as F1 Connectivity line');
            return true;
            break;
        case 0x420:  // not tested
            if (debug) console.log('Chip recognized as F1 Medium-density value line');
            return true;
            break;
        case 0x428: // not tested
            if (debug) console.log('Chip recognized as F1 High-density value line');
            return true;
            break;
        case 0x430: // not tested
            if (debug) console.log('Chip recognized as F1 XL-density value line');
            return true;
            break;
        case 0x416: // not tested
            if (debug) console.log('Chip recognized as L1 Medium-density ultralow power');
            return true;
            break;
        case 0x436: // not tested
            if (debug) console.log('Chip recognized as L1 High-density ultralow power');
            return true;
            break;
        case 0x427: // not tested
            if (debug) console.log('Chip recognized as L1 Medium-density plus ultralow power');
            return true;
            break;
        case 0x411: // not tested
            if (debug) console.log('Chip recognized as F2 STM32F2xxxx');
            return true;
            break;
        case 0x440: // not tested
            if (debug) console.log('Chip recognized as F0 STM32F051xx');
            return true;
            break;
        case 0x444: // not tested
            if (debug) console.log('Chip recognized as F0 STM32F050xx');
            return true;
            break;
        case 0x413: // not tested
            if (debug) console.log('Chip recognized as F4 STM32F40xxx/41xxx');
            return true;
            break;
        case 0x419: // not tested
            if (debug) console.log('Chip recognized as F4 STM32F427xx/437xx, STM32F429xx/439xx');
            return true;
            break;
        case 0x432: // not tested
            if (debug) console.log('Chip recognized as F3 STM32F37xxx, STM32F38xxx');
            return true;
            break;
        case 0x422: // not tested
            if (debug) console.log('Chip recognized as F3 STM32F30xxx, STM32F31xxx');
            return true;
            break;
        default: 
            if (debug) console.log('Chip NOT recognized: ' + signature);
            return false;
    };
};

// first_array = usually hex_to_flash array
// second_array = usually verify_hex array
// result = true/false
STM32_protocol.prototype.verify_flash = function(first_array, second_array) {
    for (var i = 0; i < first_array.length; i++) {
        if (first_array[i] != second_array[i]) {
            if (debug) console.log('Verification failed on byte: ' + i + ' expected: 0x' + first_array[i].toString(16) + ' received: 0x' + second_array[i].toString(16));
            return false;
        }
    }
    
    if (debug) console.log('Verification successful, matching: ' + first_array.length + ' bytes');
    
    return true;
};

// step = value depending on current state of upload_procedure
STM32_protocol.prototype.upload_procedure = function(step) {
    var self = this;
    self.steps_executed++;
    
    switch (step) {
        case 1:
            // initialize serial interface on the MCU side, auto baud rate settings
            self.send([0x7F], 1, function(reply) {
                if (self.verify_response(self.status.ACK, reply)) {
                    if (debug) console.log('STM32 - Serial interface initialized on the MCU side');
                    
                    // proceed to next step
                    self.upload_procedure(2);
                }
            });
            break;
        case 2:
            // get version of the bootloader and supported commands
            self.send([self.command.get, 0xFF], 2, function(data) { // 0x00 ^ 0xFF               
                if (self.verify_response(self.status.ACK, data)) {
                    self.send([], data[1] + 2, function(data) {  // data[1] = number of bytes that will follow (should be 12 + ack)
                        if (debug) console.log('STM32 - Bootloader version: ' + (parseInt(data[0].toString(16)) / 10).toFixed(1)); // convert dec to hex, hex to dec and add floating point
                        
                        // proceed to next step
                        self.upload_procedure(3);
                    });
                }
            });
            break;
        case 3:
            // get ID (device signature)
            self.send([self.command.get_ID, 0xFD], 2, function(data) { // 0x01 ^ 0xFF
                if (self.verify_response(self.status.ACK, data)) {
                    self.send([], data[1] + 2, function(data) { // data[1] = number of bytes that will follow (should be 1 + ack), its 2 + ack, WHY ???
                        var signature = (data[0] << 8) | data[1];
                        if (debug) console.log('STM32 - Signature: 0x' + signature.toString(16)); // signature in hex representation
                        
                        if (self.verify_chip_signature(signature)) {
                            // proceed to next step
                            self.upload_procedure(4);
                        } else {
                            // disconnect
                            self.upload_procedure(99);
                        }
                    });
                }
            });
            break;
        case 4:
            // erase memory
            if (debug) console.log('Executing global chip erase');
            command_log('Erasing chip...');
            
            self.send([self.command.erase, 0xBC], 1, function(reply) { // 0x43 ^ 0xFF
                if (self.verify_response(self.status.ACK, reply)) {
                    self.send([0xFF, 0x00], 1, function(reply) {
                        if (self.verify_response(self.status.ACK, reply)) {
                            command_log('Erasing <span style="color: green;">done</span>');
                            command_log('Writing data ...');
                            
                            // proceed to next step
                            self.upload_procedure(5); 
                        }
                    });
                }
            });
            break;
        case 5:
            // upload
            if (self.bytes_flashed < self.hex.data.length) {
                if ((self.bytes_flashed + 256) <= self.hex.data.length) {
                    var data_length = 256;
                } else {
                    var data_length = self.hex.data.length - self.bytes_flashed;
                }
                if (debug) console.log('STM32 - Writing to: 0x' + self.flashing_memory_address.toString(16) + ', ' + data_length + ' bytes');
                
                self.send([self.command.write_memory, 0xCE], 1, function(reply) { // 0x31 ^ 0xFF
                    if (self.verify_response(self.status.ACK, reply)) {
                        // address needs to be transmitted as 32 bit integer, we need to bit shift each byte out and then calculate address checksum
                        var address = [(self.flashing_memory_address >> 24), (self.flashing_memory_address >> 16), (self.flashing_memory_address >> 8), self.flashing_memory_address];
                        var address_checksum = address[0] ^ address[1] ^ address[2] ^ address[3];
                        
                        self.send([address[0], address[1], address[2], address[3], address_checksum], 1, function(reply) { // write start address + checksum
                            if (self.verify_response(self.status.ACK, reply)) {
                                var array_out = new Array(data_length + 2); // 2 byte overhead [N, ...., checksum]
                                array_out[0] = data_length - 1; // number of bytes to be written (to write 128 bytes, N must be 127, to write 256 bytes, N must be 255)
                                
                                var checksum = array_out[0];
                                for (var i = 0; i < data_length; i++) {
                                    array_out[i + 1] = self.hex.data[self.bytes_flashed]; // + 1 because of the first byte offset
                                    checksum ^= self.hex.data[self.bytes_flashed];
                                    
                                    self.bytes_flashed++;
                                    self.flashing_memory_address++;
                                }
                                
                                array_out[array_out.length - 1] = checksum; // checksum (last byte in the array_out array)

                                self.send(array_out, 1, function(reply) {
                                    if (self.verify_response(self.status.ACK, reply)) {
                                        // flash another page
                                        self.upload_procedure(5);
                                    }
                                });
                            }
                        });
                    }
                });
                
            } else {
                command_log('Writing <span style="color: green;">done</span>');
                command_log('Verifying data ...');
                
                // proceed to next step
                self.upload_procedure(6);
            }
            break;
        case 6:
            // verify
            if (self.bytes_verified < self.hex.data.length) {
                if ((self.bytes_verified + 256) <= self.hex.data.length) {
                    var data_length = 256;
                } else {
                    var data_length = self.hex.data.length - self.bytes_verified;
                }
                if (debug) console.log('STM32 - Reading from: 0x' + self.verify_memory_address.toString(16) + ', ' + data_length + ' bytes');
                
                self.send([self.command.read_memory, 0xEE], 1, function(reply) { // 0x11 ^ 0xFF
                    if (self.verify_response(self.status.ACK, reply)) {
                        var address = [(self.verify_memory_address >> 24), (self.verify_memory_address >> 16), (self.verify_memory_address >> 8), self.verify_memory_address];
                        var address_checksum = address[0] ^ address[1] ^ address[2] ^ address[3];
                        
                        self.send([address[0], address[1], address[2], address[3], address_checksum], 1, function(reply) { // read start address + checksum
                            if (self.verify_response(self.status.ACK, reply)) {
                                var bytes_to_read_n = data_length - 1;
                                
                                self.send([bytes_to_read_n, (~bytes_to_read_n) & 0xFF], 1, function(reply) { // bytes to be read + checksum XOR(complement of bytes_to_read_n)
                                    if (self.verify_response(self.status.ACK, reply)) {
                                        self.send([], data_length, function(data) {
                                            for (var i = 0; i < data.length; i++) {
                                                self.verify_hex.push(data[i]);
                                                self.bytes_verified++;
                                            }
                                            
                                            self.verify_memory_address += data_length;
                                            
                                            // verify another page
                                            self.upload_procedure(6);
                                        });
                                    }
                                });
                            }
                        });
                    }
                });
            } else {
                var result = self.verify_flash(self.hex.data, self.verify_hex);
                
                if (result) {
                    command_log('Verifying <span style="color: green;">done</span>');
                    command_log('Programming: <span style="color: green;">SUCCESSFUL</span>');
                    
                    // proceed to next step
                    self.upload_procedure(7);   
                } else {
                    command_log('Verifying <span style="color: red;">failed</span>');
                    command_log('Programming: <span style="color: red;">FAILED</span>');
                    
                    // disconnect
                    self.upload_procedure(99); 
                }   
            }
            break;
        case 7:
            // go
            // memory address = 4 bytes, 1st high byte, 4th low byte, 5th byte = checksum XOR(byte 1, byte 2, byte 3, byte 4)
            if (debug) console.log('Sending GO command: 0x' + self.hex.extended_linear_address[0].toString(16));

            self.send([self.command.go, 0xDE], 1, function(reply) { // 0x21 ^ 0xFF
                if (self.verify_response(self.status.ACK, reply)) {
                    var gt_address = self.hex.extended_linear_address[0];
                    var address = [(gt_address >> 24), (gt_address >> 16), (gt_address >> 8), gt_address];
                    var address_checksum = address[0] ^ address[1] ^ address[2] ^ address[3];
                    
                    self.send([address[0], address[1], address[2], address[3], address_checksum], 1, function(reply) {
                        if (self.verify_response(self.status.ACK, reply)) {
                            // disconnect
                            self.upload_procedure(99);
                        }
                    });
                }
            });
            break;
        case 99:
            // disconnect
            
            // remove listeners
            chrome.serial.onReceive.listeners_.forEach(function(listener) {
                chrome.serial.onReceive.removeListener(listener.callback);
            });
            
            GUI.interval_remove('firmware_uploader_read'); // stop reading serial
            GUI.interval_remove('STM32_timeout'); // stop STM32 timeout timer (everything is finished now)
            
            if (debug) console.log('Script finished after: ' + (microtime() - self.upload_time_start).toFixed(4) + ' seconds');
            if (debug) console.log('Script finished after: ' + self.steps_executed + ' steps');
            
            // close connection
            chrome.serial.disconnect(connectionId, function(result) {
                if (result) { // All went as expected
                    if (debug) console.log('Connection closed successfully.');
                    command_log('<span style="color: green">Successfully</span> closed serial connection');
                    
                    connectionId = -1; // reset connection id
                } else { // Something went wrong
                    if (debug) console.log('There was an error that happened during "connection-close" procedure');
                    command_log('<span style="color: red">Failed</span> to close serial port'); 
                }
                
                // unlocking connect button
                GUI.connect_lock = false;
            });
            break;
    }
};

// initialize object
var STM32 = new STM32_protocol();