// GUI control object, storing current UI state, currently locked elements, etc
// Mode guide -
// 0 = disconnected (or "connection not established yet")
// 1 = normal operation (configurator)
// 2 = firmware flash mode
// 3 = spectrum analyzer mode
var GUI_control = function() {
    this.auto_connect = 0;
    this.connecting_to = false;
    this.connected_to = false;
    this.operating_mode = 0;
    this.connect_lock = false;
    this.tab_lock_default_state = [1, 1, 1, 0, 0]; // needs to match tab count
    this.tab_lock = [];
    this.active_tab;
    this.operating_system;
    this.optional_usb_permissions = false; // controlled by usb permissions code
    this.interval_array = [];
    this.timeout_array = [];
    
    // initialize tab_lock array from tab_lock_defualt_state array data
    for (var i = 0; i < this.tab_lock_default_state.length; i++) {
       this.tab_lock[i] = this.tab_lock_default_state[i];
    }
    
    // check which operating system is user running
    if (navigator.appVersion.indexOf("Win") != -1)          this.operating_system = "Windows";
    else if (navigator.appVersion.indexOf("Mac") != -1)     this.operating_system = "MacOS";
    else if (navigator.appVersion.indexOf("CrOS") != -1)    this.operating_system = "ChromeOS";
    else if (navigator.appVersion.indexOf("Linux") != -1)   this.operating_system = "Linux";
    else if (navigator.appVersion.indexOf("X11") != -1)     this.operating_system = "UNIX";
};

// Tab managing methods

// index = tab index
GUI_control.prototype.lock = function(index) {
    this.tab_lock[index] = 1;
};

// index = tab index
GUI_control.prototype.unlock = function(index) {
    this.tab_lock[index] = 0;
};

// state = true (lock all tabs)
// state = false (unlock all tabs)
GUI_control.prototype.lock_all = function(state) {
    if (state) { // lock all
        for (var i = 0; i < this.tab_lock.length; i++) {
            this.tab_lock[i] = 1;
        }
    } else { // unlock all
        for (var i = 0; i < this.tab_lock.length; i++) {
            this.tab_lock[i] = 0;
        }
    }
};

// no input parameters
GUI_control.prototype.lock_default = function() {
    for (var i = 0; i < this.tab_lock_default_state.length; i++) {
       this.tab_lock[i] = this.tab_lock_default_state[i];
    }
    
    return true;
};

// Timer managing methods

// name = string
// code = function reference (code to be executed)
// interval = time interval in miliseconds
// first = true/false if code should be ran initially before next timer interval hits
GUI_control.prototype.interval_add = function(name, code, interval, first) {
    var data = {'name': name, 'timer': undefined, 'interval': interval, 'fired' : 0};
    
    if (first == true) {
        code(); // execute code
        
        data.fired++; // increment counter
    }
    
    data.timer = setInterval(function() {
        code(); // execute code
        
        data.fired++; // increment counter
    }, interval);
    
    this.interval_array.push(data); // push to primary interval array
};

// name = string
GUI_control.prototype.interval_remove = function(name) {
    for (var i = 0; i < this.interval_array.length; i++) {
        if (this.interval_array[i].name == name) {
            clearInterval(this.interval_array[i].timer); // stop timer
            
            this.interval_array.splice(i, 1); // remove element/object from array
        
            return true;
        }
    }
    
    return false;
};

// input = array of timers thats meant to be kept
// return = returns timers killed in last call
GUI_control.prototype.interval_kill_all = function(keep_array) {
    var timers_killed = 0;
    
    for (var i = (this.interval_array.length - 1); i >= 0; i--) { // reverse iteration
        var self = this;
        
        var keep = false;
        keep_array.forEach(function(name) {
            if (self.interval_array[i].name == name) {
                keep = true;
            }
        });
        
        if (!keep) {
            clearInterval(this.interval_array[i].timer); // stop timer
            this.interval_array[i].timer = undefined; // set timer property to undefined (mostly for debug purposes, but it doesn't hurt to have it here)
            
            this.interval_array.splice(i, 1); // remove element/object from array
            
            timers_killed++;
        }
    }
    
    return timers_killed;
};

// name = string
// code = function reference (code to be executed)
// timeout = timeout in miliseconds
GUI_control.prototype.timeout_add = function(name, code, timeout) {
    var self = this;
    // start timer with "cleaning" callback
    var timer = setTimeout(function() {
        code(); // execute code
        
        self.timeout_remove(name); // cleanup
    }, timeout);
    
    this.timeout_array.push({'name': name, 'timer': timer, 'timeout': timeout}); // push to primary timeout array
};

// name = string
GUI_control.prototype.timeout_remove = function(name) {
    for (var i = 0; i < this.timeout_array.length; i++) {
        if (this.timeout_array[i].name == name) {
            clearTimeout(this.timeout_array[i].timer); // stop timer
            
            this.timeout_array.splice(i, 1); // remove element/object from array
            
            return true;
        }
    }
    
    return false;
};

// no input paremeters
// return = returns timers killed in last call
GUI_control.prototype.timeout_kill_all = function() {
    var timers_killed = 0;
    
    for (var i = 0; i < this.timeout_array.length; i++) {
        clearTimeout(this.timeout_array[i].timer); // stop timer
        
        timers_killed++;
    }
    
    this.timeout_array = []; // drop objects
    
    return timers_killed;
};

// Method is called every time a valid tab change event is received
// callback = code to run when cleanup is finished
// default switch doesn't require callback to be set
GUI_control.prototype.tab_switch_cleanup = function(callback) {
    switch (this.active_tab) {
        case 'rx_connecting':
            if (debug) console.log('Executing "rx_connecting" cleanup routine');
            GUI.interval_remove('RX_join_configuration'); // stop counter (in case its still running)
            
            PSP.callbacks.push({'code': PSP.PSP_REQ_RX_JOIN_CONFIGURATION, 'callback': callback});
            
            send([0x00]); // sending any data in this stage will "break" the timeout
            break;
            
        case 'spectrum_analyzer':
            if (debug) console.log('Executing "spectrum_analyzer" cleanup routine');
            GUI.interval_remove('SA_redraw_plot'); // disable plot re-drawing timer
            
            send("#1,,,,", function() { // #1,,,, (exit command)          
                GUI.operating_mode = 1; // configurator 
                if (callback) callback();
            });
            break;
            
        default:
            if (callback) callback();
    }
};

// initialize object into GUI variable
var GUI = new GUI_control();