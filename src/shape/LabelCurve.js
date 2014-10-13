define(function (require) {

    var ShapeBase = require('zrender/shape/Base');
    var LineShape = require('zrender/shape/Line');
    var zrUtil = require('zrender/tool/util');
    var curveTool = require('zrender/tool/curve');

    var LabelLineShape = require('./LabelLine');

    var LabelCurve = function (opts) {
        ShapeBase.call(this, opts);
    }

    LabelCurve.prototype.type = 'labelcurve';

    LabelCurve.prototype.brush = function (ctx, isHighlight) {
        var style = this.style;

        if (isHighlight) {
            // 根据style扩展默认高亮样式
            style = this.getHighlightStyle(
                style,
                this.highlightStyle || {},
                this.brushTypeOnly
            );
        }

        ctx.save();
        this.doClip(ctx);
        this.setContext(ctx, style);
        // 设置transform
        this.setTransform(ctx);

        ctx.beginPath();
        ctx.moveTo(style.xStart, style.yStart);
        ctx.quadraticCurveTo(style.cpX1, style.cpY1, style.xEnd, style.yEnd);
        ctx.stroke();

        // 画Label圆
        ctx.globalAlpha = 1;
        var cx = style.cx;
        var cy = style.cy;
        var r = style.r || 10;
        if (cx == null) {
            cx = curveTool.quadraticAt(style.xStart, style.cpX1, style.xEnd, 0.5);
            cy = curveTool.quadraticAt(style.yStart, style.cpY1, style.yEnd, 0.5);
        }
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();

        // 画Label标签
        var text = style.text;
        var textPadding = style.textPadding;
        if (textPadding == null) { textPadding = 5; }

        ctx.font = style.textFont;
        var x = cx + r + textPadding;
        var y = cy;
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x, y);

        var width = ctx.measureText(text).width;
        var height = ctx.measureText('国').width;
        // 顺便保存rect
        this.__rect = {
            x: cx - r * 2,
            y: cy - Math.max(r * 2, height / 2),
            width: width + r * 4 + textPadding,
            height: Math.max(height, r * 4)
        };

        ctx.restore();
    }

    LabelCurve.prototype.getRect = LabelLineShape.prototype.getRect;

    LabelCurve.prototype.isCover = LabelLineShape.prototype.isCover;

    zrUtil.inherits(LabelCurve, ShapeBase);

    return LabelCurve;
});