define(function (require) {

    var util = {
        indexOf: function (array, value) {
            if (array.indexOf) {
                return array.indexOf(value);
            }
            for (var i = 0, len = array.length; i < len; i++) {
                if (array[i] === value) {
                    return i;
                }
            }
            return -1;
        },

        bind: function (func, context) {
            if (func.bind) {
                return func.bind(context);
            } else {
                return function () {
                    func.apply(context, arguments);
                }
            }
        },

        addEventListener: function (el, name, func) {
            if (window.addEventListener) {
                el.addEventListener(name, func);
            } else {
                el.attachEvent(name, func);
            }
        },

        getStyle: function (el, name) {
            var style;
            if (window.getComputedStyle) {
                style = window.getComputedStyle(el, null);
            } else if (docment.documentElement.currentStyle) {
                style = el.currentStyle;
            }
            if (name) {
                return style[name];
            } else {
                return style;
            }
        },

        addClass: function (el, className) {
            if (el.classList) {
                el.classList.add(className);
            } else {
                if (el.className.indexOf(className) < 0) {
                    el.className += ' ' + className;
                }
            }
        },

        removeClass: function (el, className) {
            if (el.classList) {
                el.classList.remove(className);
            } else {
                el.className.replace(className, '');
            }
        }
    }

    return util;
});