define(function (require) {

    var zrender = require('zrender');
    var Graph = require('echarts/data/Graph');
    var Tree = require('echarts/data/Tree');
    var TreeLayout = require('echarts/layout/Tree');
    var zrUtil = require('zrender/tool/util');
    var Group = require('zrender/Group');
    var CircleShape = require('zrender/shape/Circle');
    var Component = require('./Component');
    var vec2 = require('zrender/tool/vector');

    var ForceLayout = require('../layout/ForceLayout');
    var NodeEntity = require('../entity/Node');
    var CurveEdgeEntity = require('../entity/CurveEdge');
    var OutTipEntity = require('../entity/OutTip');
    var ExtraEdgeBundleEntity = require('../entity/ExtraEdgeBundle');

    var Parallax = require('../util/Parallax');
    var bkgLog = require('../util/log');
    var util = require('../util/util');
    var intersect = require('../util/intersect');
    var jsonp = require('../util/jsonp');
    var cookies = require('../util/cookies');

    var Cycle = require('./Cycle');

    var config = require('../config');

    var EPSILON = 1e-2;
    var isAroundZero = function (val) {
        return val > -EPSILON && val < EPSILON;
    }
    function isNotAroundZero(val) {
        return val > EPSILON || val < -EPSILON;
    }

    var GraphMain = function () {

        Component.call(this);

        this.minRadius = 30;
        this.maxRadius = 40;

        this.draggable = false;

        this.enableEntryAnimation = true;

        this._kgraph = null;
        
        this._zr = null;

        // Graph for rendering
        // 包含补边
        this._graph = null;

        // Graph for layouting
        // 不包含补边（补边不影响布局
        this._graphLayout = null;

        this._layouting = false;

        this._animating = false;

        this._root = null;

        // 中心节点
        this._mainNode = null;

        this._lastHoverNode = null;

        this._lastHoverEdge = null;

        this._currentActiveNode = null;

        // 图中所有的节点数
        this._nodeEntityCount = 0;
        // 第一次展现的节点数，用于计算用户探索的百分比
        this._baseEntityCount = 0;

        // 默认展开层数
        this._defaultLayerCount = 1;

        this._parallax = null;

        // 是否是第一帧渲染
        this._isFirstFrame = true;
    };

    GraphMain.prototype.type = 'GRAPH';

    GraphMain.prototype.initialize = function (kg) {
        this._kgraph = kg;

        var el = this.el;
        this.el.className = 'bkg-graph';

        el.style.width = kg.getWidth() + 'px';
        el.style.height = kg.getHeight() + 'px';

        this._initBG();
        this._initZR();

        var self = this;
        util.addEventListener(el, 'mousedown', function () {
            self._mouseDown = true;
            self.hideTip();
        });
        util.addEventListener(el, 'mouseup', function () {
            self._mouseDown = false;
        });
    };

    GraphMain.prototype.enableDrag = function () {
        this.draggable = true;
        this._graph.eachNode(function (n) {
            if (n.entity) {
                n.entity.setDraggable(true);
            }
        });
    };

    GraphMain.prototype.disableDrag = function () {
        this.draggable = false;
        this._graph.eachNode(function (n) {
            if (n.entity) {
                n.entity.setDraggable(false);
            }
        });
    };

    GraphMain.prototype.refresh = function () {
        this._zr.refreshNextFrame();
    };

    GraphMain.prototype.getGraph = function () {
        return this._graph;
    };

    GraphMain.prototype.getZR = function () {
        return this._zr;
    };

    GraphMain.prototype.getMainNode = function () {
        return this._graph.getNodeById(this._mainNode.id);
    };

    GraphMain.prototype.getCircles = function () {
        return this._circles;
    };

    GraphMain.prototype._initZR = function () {
        $zrContainer = document.createElement('div');
        $zrContainer.className = 'bkg-graph-zr';

        this.el.appendChild($zrContainer);

        this._zr = zrender.init($zrContainer);

        var zrRefresh = this._zr.painter.refresh;
        var self = this;
        var zr = this._zr;

        this._min = [Infinity, Infinity];
        this._max = [zr.getWidth() / 2, zr.getHeight() / 2];
        var x0 = 0, y0 = 0, sx0 = 0, sy0 = 0;

        var currentTime = new Date().getTime();
        zr.painter.refresh = function () {
            // 默认只对第一层开启拖拽和缩放，所以需要手动同步所有层的位移和缩放
            var layers = zr.painter.getLayers();
            var layer0 = layers[0];
            if (layer0) {
                var position = layer0.position;
                var scale = layer0.scale;
                // 限制拖拽的范围
                position[0] = Math.max(-self._max[0] * scale[0] + zr.getWidth() - 500, position[0]);
                position[1] = Math.max(-self._max[1] * scale[1] + zr.getHeight() - 300, position[1]);
                position[0] = Math.min(-self._min[0] * scale[0] + 500, position[0]);
                position[1] = Math.min(-self._min[1] * scale[1] + 300, position[1]);

                var isPanned = isNotAroundZero(position[0] - x0) || isNotAroundZero(position[1] - y0);
                var isZoomed = isNotAroundZero(scale[0] - sx0) || isNotAroundZero(scale[1] - sy0);

                for (var z in layers) {
                    if (z !== 'hover') {
                        // 层的位置没同步
                        if (
                            isNotAroundZero(position[0] - layers[z].position[0]) || isNotAroundZero(position[1] - layers[z].position[1])
                            || isNotAroundZero(scale[0] - layers[z].scale[0]) || isNotAroundZero(scale[1] - layers[z].scale[1])
                        ) {
                            layers[z].dirty = true;
                        }
                        vec2.copy(layers[z].position, position);
                        vec2.copy(layers[z].scale, scale);
                    }
                }

                if (isPanned || isZoomed) {
                    for (var z in layers) {
                        if (z !== 'hover') {
                            layers[z].dirty = true;   
                        }
                    }

                    self._syncOutTipEntities();

                    if (isPanned) {
                        var time = new Date().getTime();
                        // 至少隔两秒发送拖拽日志
                        if ((time - currentTime) >= 2000 && self._mouseDown) {
                            bkgLog({
                                type: 'zhishitupupan',
                                target: position[0] + ',' + position[1]
                            });
                            currentTime = time;
                        }
                    }
                    if (isZoomed) {
                        var time = new Date().getTime();
                        // 至少隔两秒发送拖拽日志
                        if ((time - currentTime) >= 2000) {
                            bkgLog({
                                type: 'zhishitupuzoom',
                                target: scale[0]
                            });
                            currentTime = time;
                        }
                    }
                }
                x0 = position[0];
                y0 = position[1];
                sx0 = scale[0];
                sy0 = scale[1];

                // 背景的视差移动
                if (self._parallax) {
                    self._parallax.moveTo(x0 / sx0, y0 / sy0);
                }
            }

            self._culling();
            
            zrRefresh.apply(this, arguments);
        }

        // 不显示hover层
        var layers = zr.painter.getLayers();
        for (var z in layers) {
            if (z === 'hover') {
                layers[z].dom.parentNode.removeChild(layers[z].dom);
            }
        }
    }

    GraphMain.prototype._initBG = function () {

        var $bg = document.createElement('div');
        $bg.className = 'bkg-graph-bg';

        this.el.appendChild($bg);

        $bg.innerHTML = '<div class="bkg-bg-layer"></div>';
        this._parallax = new Parallax($bg);

        this._parallax.scaleBase = 0.4;
        this._parallax.scaleStep = 0.5;

        this._parallax.setOffset(2000, 2000);
    }

    GraphMain.prototype.resize = function (w, h) {

        this.el.style.width = w + 'px';
        this.el.style.height = h + 'px';

        this._zr.resize();

        this._syncOutTipEntities();
    };

    GraphMain.prototype.setData = function (data) {
        var graph = new Graph(true);
        this._graphLayout = graph;
        var zr = this._zr;

        var cx = this._kgraph.getWidth() / 2;
        var cy = this._kgraph.getHeight() / 2;

        // var vWidth, vHeight;
        var width = zr.getWidth();
        var height = zr.getHeight();

        // 映射数据
        var max = -Infinity;
        var min = Infinity;
        for (var i = 0; i < data.entities.length; i++) {
            var entity = data.entities[i];
            min = Math.min(min, entity.hotValue);
            max = Math.max(max, entity.hotValue);
        }
        var diff = max - min;

        var noPosition = false;
        for (var i = 0; i < data.entities.length; i++) {
            var entity = data.entities[i];
            var n = graph.addNode(entity.id, entity);
            var r = diff > 0 ?
                (entity.hotValue - min) * (this.maxRadius - this.minRadius) / diff + this.minRadius
                : (this.maxRadius + this.minRadius) / 2;
            if (entity.layerCounter === 0) {
                r = 70;
                this._mainNode = n;
            }
            n.layout = {
                position: entity.position,
                size: r
            };
            // Fix the center node
            if (entity.layerCounter === 0) {
                n.layout.fixed = true;
            }
            if (!entity.position) {
                noPosition = true;
                if (entity.layerCounter === 0) {
                    n.layout.position = [
                        width / 2,
                        height / 2
                    ];
                    n.position = Array.prototype.slice.call(n.layout.position);
                }
            }
        }

        for (var i = 0; i < data.relations.length; i++) {
            var relation = data.relations[i];
            if (!relation.isExtra) {
                graph.addEdge(relation.fromID, relation.toID, relation);
            }
        }

        // 加入补边
        this._graph = this._graphLayout.clone();
        this._graph.eachNode(function (n) {
            // 共用布局
            n.layout = this._graphLayout.getNodeById(n.id).layout;
        }, this);
        for (var i = 0; i < data.relations.length; i++) {
            var relation = data.relations[i];
            if (relation.isExtra) {
                var e = this._graph.addEdge(relation.fromID, relation.toID, relation);
                if (e) {
                    e.isExtra = true;
                }
            }
        }

        if (noPosition) {
            this.radialTreeLayout();
        } else {
            // 平移所有节点，使得中心节点能够在屏幕中心
            var offsetX = width / 2 - this._mainNode.layout.position[0];
            var offsetY = height / 2 - this._mainNode.layout.position[1];

            this._graph.eachNode(function (n) {
                n.layout.position[0] += offsetX;
                n.layout.position[1] += offsetY;
            })
        }

        this.render();

        this._loadStorage();

        // var circles = this._findCircles(config.circleKeywords.split(','));
        // this._circles = circles;
        // for (var i = 0; i < circles.length; i++) {
        //     this._highlightCircle(circles[i]);
        // }

        // 刚打开时的展开动画
        // if (config.enableAnimation && this.enableEntryAnimation) {
            // this._entryAnimation();
        // }

        // 发送首屏展现日志
        var title = [];
        this._graph.eachNode(function (node) {
            if (node.entity) {
                title.push(node.id, node.data.layerCounter);
            }
        });

        var nodeNum = 200; // 每条日志中传的最大节点个数
        var sendLogTimes = Math.ceil(title.length / nodeNum); // 发送次数
        var logParam = [];
        var params = util.getURLSearch();
        for (var times = 0; times < sendLogTimes; times++) {
            logParam = [];
            var len = (times + 1) * nodeNum > title.length ? title.length : (times + 1) * nodeNum;
            for (var j = times * nodeNum; j < len; j++) {
                logParam.push(title[j]);
            }

            bkgLog({
                type: 'zhishitupuse',
                target: logParam.join(','),
                page: sendLogTimes + '-' + (times + 1),
                extend: (params['srcid'] ? params['srcid'] : '')
            });
        }
    };

    GraphMain.prototype.render = function () {
        var zr = this._zr;
        var graph = this._graph;

        if (this._root) {
            zr.delGroup(this._root);
        }
        this._root = new Group();
        zr.addGroup(this._root);

        // 补边使用bundle优化性能
        if (config.enableAnimation) {
            this._extraEdgeBundle = new ExtraEdgeBundleEntity();
            this._extraEdgeBundle.initialize(zr);
            this._root.addChild(this._extraEdgeBundle.el);
        }

        graph.eachEdge(function (e) {
            if (
                e.node1.data.layerCounter <= this._defaultLayerCount &&
                e.node2.data.layerCounter <= this._defaultLayerCount
            ) {
                if (!e.isExtra) {
                    if (!e.node1.entity) {
                        this._baseEntityCount++;
                        this._createNodeEntity(e.node1);
                    }
                    if (!e.node2.entity) {
                        this._baseEntityCount++;
                        this._createNodeEntity(e.node2)
                    }
                }
                this._createEdgeEntity(e);
            }
        }, this);

        zr.refreshNextFrame();

        zr.modLayer(0, {
            panable: true,
            zoomable: true,
            maxZoom: 1.5,
            minZoom: 0.6
        });
    };

    /**
     * 放射树状布局
     */
    GraphMain.prototype.radialTreeLayout = function () {
        var cx = this._zr.getWidth() / 2;
        var cy = this._zr.getHeight() / 2;
        var tree = Tree.fromGraph(this._graphLayout)[0];

        var root = tree.root;
        // 第一层节点均匀排布，大的子树相离尽量远
        if (root.children.length > 2) {
            for (var i = 0; i < root.children.length; i++) {
                var child = root.children[i];
                child.__size = 0;
                root.children[i].traverse(function () {
                    child.__size++;
                });
            }
            root.children.sort(function (a, b) {
                return b.__size - a.__size;
            });
            var res = [root.children[0], root.children[1]];
            var currentIdx = 1;
            for (i = 2; i < root.children.length; i++) {
                res.splice(currentIdx, 0, root.children[i]);
                currentIdx += 2;
                if (currentIdx > res.length) {
                    currentIdx = 1;
                }
            }
            root.children = res;
        }

        tree.traverse(function (treeNode) {
            var graphNode = this._graphLayout.getNodeById(treeNode.id);
            treeNode.layout = {
                width: graphNode.layout.size * 2,
                height: graphNode.layout.size * 2
            };
        }, this);
        var layout = new TreeLayout();

        layout.layerPadding = function (level) {
            return config.layout.layerDistance[level] || 200;
        };
        layout.run(tree);

        var min = [Infinity, Infinity];
        var max = [-Infinity, -Infinity];
        tree.traverse(function (treeNode) {
            vec2.min(min, min, treeNode.layout.position);
            vec2.max(max, max, treeNode.layout.position);
        });
        var width = max[0] - min[0];
        if (width === 0) {
            width = 0.01;
        }
        var height = max[1] - min[1];
        tree.traverse(function (treeNode) {
            var graphNode = this._graphLayout.getNodeById(treeNode.id);
            var x = treeNode.layout.position[0];
            var y = treeNode.layout.position[1];
            var r = y;
            var rad = x / width * Math.PI * 2;

            graphNode.layout.position = [
                // x, y
                // 以中心节点为圆心
                r * Math.cos(rad) + cx,
                r * Math.sin(rad) + cy
            ];
            treeNode.layout.angle = rad;
        }, this);
        // 第一层节点均匀分布
        // 这个是针对类似昆凌的图谱
        if (tree.root.children.length <= 4) {
            var gap = Math.PI * 2 / tree.root.children.length;
            var angle = 0;
            for (var i = 0; i < tree.root.children.length; i++) {
                var child = tree.root.children[i];
                var r = child.layout.position[1];
                var graphNode = this._graphLayout.getNodeById(child.id);
                if (i === 0) {
                    angle = child.layout.angle;
                } else {
                    angle += gap;
                }

                graphNode.layout.position = [
                    r * Math.cos(angle) + cx,
                    r * Math.sin(angle) + cy
                ];
            }
        }
    }

    /**
     * 开始力导向布局
     */
    GraphMain.prototype.startForceLayout = function (cb) {
        var graph = this._graphLayout;
        var forceLayout = new ForceLayout();
        forceLayout.center = [
            this._kgraph.getWidth() / 2,
            this._kgraph.getHeight() / 2
        ];
        forceLayout.gravity = 0;
        forceLayout.scaling = Math.sqrt(graph.nodes.length / 100) * 12;
        forceLayout.edgeLength = Math.max(graph.nodes.length / 100 * 150, 100);
        forceLayout.preventNodeOverlap = true;
        forceLayout.preventNodeEdgeOverlap = true;

        graph.eachNode(function (n) {
            n.layout.mass = 15;
            n.layout.layer = n.data.layerCounter;
        });
        var layerDistance = config.layout.layerDistance.slice();
        for (var i = 1; i < layerDistance.length; i++) {
            layerDistance[i] = layerDistance[i - 1] + layerDistance[i];
        }

        forceLayout.layerConstraint = config.layout.layerConstraint;
        forceLayout.layerDistance = layerDistance;

        var factor = Math.sqrt(graph.nodes.length);
        graph.eachEdge(function (e) {
            e.layout = {
                weight: 20
            };
        }, this);

        forceLayout.init(graph);
        forceLayout.temperature = 0.04;
        this._layouting = true;
        var self = this;
        var count = 0;
        forceLayout.onupdate = function () {
            for (var i = 0; i < graph.nodes.length; i++) {
                var n = graph.nodes[i];
                if (n.layout.fixed && n.entity) {
                    vec2.copy(n.layout.position, n.entity.el.position);
                }
            }
            self._updateNodePositions();
            self.unactiveAll();

            if (forceLayout.isStable()) {
                self.stopForceLayout();
                cb && cb.call(self);
                // console.log(count);
            }
            else {
                if (self._layouting) {
                    requestAnimationFrame(function () {
                        forceLayout.step(10);
                    });
                    count += 10;
                }
            }
        }
        forceLayout.step(10);
    };

    /**
     * 停止力导向布局
     */
    GraphMain.prototype.stopForceLayout = function () {
        var graph = this._graphLayout;
        var edgeNodes = [];
        graph.eachNode(function (n) {
            if (n.isEdgeNode) {
                edgeNodes.push(n);
            }
        });
        for (var i = 0; i < edgeNodes.length; i++) {
            graph.removeNode(edgeNodes[i]);
        }

        this._layouting = false;
    };

    /**
     * 低亮所有节点
     */
    GraphMain.prototype.unactiveAll = function () {
        var zr = this._zr;
        var graph = this._graph;
        for (var i = 0; i < graph.nodes.length; i++) {
            var n = graph.nodes[i];
            if (n.entity) {
                n.entity.setState('normal');
            }
            // 移除屏外提示
            if (n._outTipEntity) {
                this._root.removeChild(n._outTipEntity.el);
                n._outTipEntity = null;
            }
        }

        for (var i = 0; i < graph.edges.length; i++) {
            var e = graph.edges[i];
            if (e.entity) {
                e.entity.setState('normal');
                if (e.isExtra) {
                    e.entity.hidden = true;
                }
            }
        }

        this._currentActiveNode = null;

        zr.refreshNextFrame();
    };

    /**
     * 节点移除hover特效
     */
    GraphMain.prototype.unhoverNode = function () {
        var node = this._lastHoverNode;
        if (node && node.entity) {
            if (node.entity.getState() !== 'active') {
                node.entity.setState('normal');
            }
            this._lastHoverNode = null;
        }
    };

    /**
     * 鼠标 hover 到节点上的特效
     */
    GraphMain.prototype.hoverNode = function (node) {
        this.unhoverEdge();

        this.unhoverNode();

        if (node.entity) {
            node.entity.setState('hover');

            this._lastHoverNode = node;
        }
    };

    /**
     * 边移除hover特效
     */
    GraphMain.prototype.unhoverEdge = function () {
        var edge = this._lastHoverEdge;
        if (edge && edge.entity) {
            if (edge.entity.getState() !== 'active') {
                edge.entity.setState('normal');
            }
            this._lastHoverEdge = null;
        }
    };

    /**
     * 鼠标 hover 到边上的特效
     */
    GraphMain.prototype.hoverEdge = function (edge) {
        this.unhoverNode();

        this.unhoverEdge();

        if (edge.entity) {
            edge.entity.setState('hover');

            this._lastHoverEdge = edge;
        }
    };

    GraphMain.prototype.activeEdge = function (edge) {
        if (typeof(edge) === 'string') {
            edge = this._getEdgeByID(edge);
        }

        if (edge && edge.entity) {
            this.unactiveAll();
            edge.entity.setState('active');

            if (edge.isExtra) {
                edge.entity.hidden = false;
            }

        }
    };

    GraphMain.prototype.activeNode = function (node) {
        if (typeof(node) === 'string') {
            node = this._graph.getNodeById(node);
        }
        var zr = this._zr;

        if (node && node.entity) {
            this.unactiveAll();

            node.entity.setState('active');

            this._currentActiveNode = node;
        }
    };

    /**
     * 高亮节点+显示邻接节点, 点击触发
     */
    GraphMain.prototype.activeNodeAndShowAdjacency = function (node) {
        if (typeof(node) === 'string') {
            node = this._graph.getNodeById(node);
        }
        var zr = this._zr;

        if (! node || ! node.entity) {
            return;
        }

        this.unactiveAll();

        node.entity.setState('active');

        this._currentActiveNode = node;

        for (var i = 0; i < node.edges.length; i++) {
            var e = node.edges[i];
            var other = e.node1 === node ? e.node2 : e.node1;

            //中心节点不出补边
            if (node.data.layerCounter === 0 && e.isExtra) {
                continue;
            }

            var newNodeEntity = false;
            var newEdgeEntity = false;
            if (!other.entity) {
                // 动态添加
                this._createNodeEntity(other);
                newNodeEntity = true;
            }

            if (!e.entity) {
                // 动态添加
                this._createEdgeEntity(e);
                newEdgeEntity = true;
            }

            if (e.isExtra) {
                e.entity.hidden = false;
            }

            if (config.enableAnimation) {
                if (newNodeEntity) {
                    this._growNodeAnimation(other, node, Math.random() * 500);
                }
                else if (newEdgeEntity) {
                    e.entity.animateLength(zr, 300, 0, node.entity);
                }
            }

            this._syncOutTipEntities();
        }

        this._syncHeaderBarExplorePercent();
        zr.refreshNextFrame();
    };

    /**
     * 在边栏中显示实体详细信息
     */
    GraphMain.prototype.showEntityDetail = function (n, showSidebar) {
        var self = this;
        var graph = this._graphLayout;
        if (typeof(n) === 'string') {
            n = graph.getNodeById(n);
        }

        var sideBar = this._kgraph.getComponentByType('SIDEBAR');
        if (sideBar) {
            sideBar.hide();

            setTimeout(function () {
                var detailData = self._loadDetailFromStorage(n.id);
                var layerCounter = n.data ? n.data.layerCounter : n.layerCounter;
                if (detailData) {
                    sideBar.setData(detailData);

                    showSidebar && sideBar.show(n.id + ',' + layerCounter);
                }
                else {
                    jsonp(self._kgraph.getDetailAPI(), { detail_id: n.id }, 'callback', function (data) {
                        data._datatype = 'entity'; // for ubs log
                        data.layerCounter = n.data ? n.data.layerCounter : n.layerCounter;
                        sideBar.setData(data);

                        showSidebar && sideBar.show(n.id + ',' + layerCounter);

                        self._saveDetailToStorage(n.id, data);
                    });
                }
            }, 300);
        }
    };

    /**
     * 在边栏中显示关系的详细信息
     */
     GraphMain.prototype.showRelationDetail = function (e) {
        if (typeof(e) === 'string') {
            e = this._getEdgeByID(e);
        }
        if (!e) {
            return;
        }
        var sideBar = this._kgraph.getComponentByType('SIDEBAR');
        if (sideBar) {
            sideBar.hide();
            // var data = {};
            // for (var name in e.data) {
            //     data[name] = e.data[name];
            // }
            var self = this;

            setTimeout(function () {
                var detailData = self._loadDetailFromStorage(e.data.id);
                var logParam = [
                        // from entity
                        e.node1.id,
                        e.node1.data.layerCounter,
                        // to entity
                        e.node2.id,
                        e.node2.data.layerCounter,
                        e.data.id,
                        e.isExtra ? 1 : 0,
                        e.isSpecial ? 1 : 0
                    ].join(',');
                if (detailData) {
                    sideBar.setData(detailData, true);
                    sideBar.show(logParam);
                }
                else {
                    jsonp(self._kgraph.getDetailAPI(), { detail_id: e.data.id }, 'callback', function (data) {

                        data.fromEntity = self._graph.getNodeById(data.fromID).data;
                        data.toEntity = self._graph.getNodeById(data.toID).data;
                        data._datatype = 'relation'; // for ubs log

                        sideBar.setData(data, true);
                        sideBar.show(logParam);

                        self._saveDetailToStorage(e.data.id, data);
                    });
                }
            }, 300);
        }
    };

    GraphMain.prototype.hideSidebar = function () {
        var sideBar = this._kgraph.getComponentByType('SIDEBAR');
        if (sideBar) {
            sideBar.hide();
        }
    };

    GraphMain.prototype.showNodeEndTip = function (n) {
        if (typeof(n) === 'string') {
            n = graph.getNodeById(n);
        }

        var tip = this._kgraph.getComponentByType('TIP');
        tip.setData(config.tip.nodeEnd, n);
    };

    GraphMain.prototype.showNodeHoverTip = function (n) {
        if (typeof(n) === 'string') {
            n = graph.getNodeById(n);
        }

        var isClicked = cookies.get('BKGraph_node_click_0') || 0;

        if (!isClicked) {
            var tip = this._kgraph.getComponentByType('TIP');
            tip.setData(config.tip.node, n);
        }
    };

    GraphMain.prototype.showEdgeClickTip = function (e, isOther) {
        if (typeof(e) === 'string') {
            e = this._getEdgeByID(e);
        }
        if (!e) {
            return;
        }

        var isClicked = cookies.get('BKGraph_edge_click_0') || 0;
        if (!isClicked) {
            this.activeEdge(e);

            var tip = this._kgraph.getComponentByType('TIP');
            var tipData = isOther ? config.tip.edgeOther : config.tip.edge;
            tip.setData(tipData, e, true);
        }
    };

    GraphMain.prototype.hideTip = function () {
        var tip = this._kgraph.getComponentByType('TIP');
        tip && tip.hide();
    };

    /**
     * 移动视图到指定的实体位置
     */
    GraphMain.prototype.moveToEntity = function (n, cb) {
        var graph = this._graph;
        if (typeof(n) === 'string') {
            n = graph.getNodeById(n);
        }
        var zr = this._zr;
        if (!n) {
            return;
        }
        var entity = n.entity;
        var layer = zr.painter.getLayer(0);
        var pos = Array.prototype.slice.call(entity.el.position);
        vec2.mul(pos, pos, layer.scale);
        vec2.sub(pos, [zr.getWidth() / 2, zr.getHeight() / 2], pos);

        this.moveTo(pos[0], pos[1], cb);
    };

    GraphMain.prototype.moveToRelation = function (e, cb) {
        if (typeof(e) === 'string') {
            e = this._getEdgeByID(e);
        }

        if (!e) {
            return;
        }
        var zr = this._zr;
        var pos1 = e.node1.entity.el.position;
        var pos2 = e.node2.entity.el.position;

        var pos = vec2.add([], pos1, pos2);
        pos[0] /= 2;
        pos[1] /= 2;

        var layer = zr.painter.getLayer(0);
        vec2.mul(pos, pos, layer.scale);
        vec2.sub(pos, [zr.getWidth() / 2, zr.getHeight() / 2], pos);

        this.moveTo(pos[0], pos[1], cb);
    }

    /**
     * 移动视图到指定的位置
     */
    GraphMain.prototype.moveTo = function (x, y, cb) {
        var zr = this._zr;
        var layers = zr.painter.getLayers();

        if (config.enableAnimation) {
            var self = this;
            self._animating = true;
            zr.animation.animate(layers[0])
                .when(800, {
                    position: [x, y]
                })
                .during(function () {
                    zr.refreshNextFrame();
                })
                .done(function () {
                    self._animating = false;
                    cb && cb();
                })
                .start('CubicInOut');   
        } else {
            var pos = layers[0].position;
            pos[0] = x;
            pos[1] = y;
            zr.refreshNextFrame();
            cb && cb();
        }

        this.hideTip();
    };

    GraphMain.prototype.moveLeft = function (cb) {
        var zr = this._zr;
        var layer = zr.painter.getLayer(0);
        var newPos = Array.prototype.slice.call(layer.position);
        newPos[0] += zr.getWidth() * 0.6;

        this.moveTo(newPos[0], newPos[1], cb);
    };

    GraphMain.prototype.moveRight = function (cb) {
        var zr = this._zr;
        var layer = zr.painter.getLayer(0);
        var newPos = Array.prototype.slice.call(layer.position);
        newPos[0] -= zr.getWidth() * 0.6;

        this.moveTo(newPos[0], newPos[1], cb);
    };

    GraphMain.prototype.moveTop = function (cb) {
        var zr = this._zr;
        var layer = zr.painter.getLayer(0);
        var newPos = Array.prototype.slice.call(layer.position);
        newPos[1] += zr.getHeight() * 0.6;

        this.moveTo(newPos[0], newPos[1], cb);
    };

    GraphMain.prototype.moveDown = function (cb) {
        var zr = this._zr;
        var layer = zr.painter.getLayer(0);
        var newPos = Array.prototype.slice.call(layer.position);
        newPos[1] -= zr.getHeight() * 0.6;

        this.moveTo(newPos[0], newPos[1], cb);
    };

    GraphMain.prototype.zoomIn = function () {
        var zr = this._zr;
        var layer = zr.painter.getLayer(0);
        layer.__zoom = layer.__zoom || 1;
        this.zoomTo(layer.__zoom * 1.3);
    };

    GraphMain.prototype.zoomOut = function () {
        var zr = this._zr;
        var layer = zr.painter.getLayer(0);
        layer.__zoom = layer.__zoom || 1;
        this.zoomTo(layer.__zoom / 1.3);
    };

    GraphMain.prototype.zoomTo = function (zoom, cb) {
        var zr = this._zr;
        var cx = zr.getWidth() / 2;
        var cy = zr.getHeight() / 2;
        var layer = zr.painter.getLayer(0);
        layer.__zoom = layer.__zoom || 1;
        zoom = Math.min(Math.max(zoom, 0.5), 1.5);

        var zoomScale = zoom / layer.__zoom;

        var newScale = Array.prototype.slice.call(layer.scale);
        var newPos = Array.prototype.slice.call(layer.position);
        newPos[0] -= (cx - newPos[0]) * (zoomScale - 1);
        newPos[1] -= (cy - newPos[1]) * (zoomScale - 1);
        newScale[0] *= zoomScale;
        newScale[1] *= zoomScale;

        zr.animation.clear();
        zr.animation.animate(layer)
            .when(800, {
                position: newPos,
                scale: newScale,
                __zoom: zoom
            })
            .during(function() {
                layer.dirty = true;
                zr.refreshNextFrame();
            })
            .done(function() {
                cb && cb();
            })
            .start('CubicInOut');

        this.hideTip();
    }

    GraphMain.prototype.uncollapse = function () {
        var zr = this._zr;
        this._graph.eachNode(function (n) {
            if (!n.entity) {
                this._createNodeEntity(n);
                n.canCollapse = true;
            }
        }, this);
        this._graph.eachEdge(function (e) {
            if (!e.entity) {
                this._createEdgeEntity(e);
                e.canCollapse = true;
            }
        }, this);

        this._syncHeaderBarExplorePercent();

        zr.refreshNextFrame();
    };

    GraphMain.prototype.collapse = function () {
        var zr = this._zr;
        this._graph.eachNode(function (n) {
            if (n.canCollapse) {
                n.entity.stopAnimationAll();
                this._root.removeChild(n.entity.el);
                n.canCollapse = false;
                n.entity = null;
                this._nodeEntityCount--;
            }
        }, this);
        this._graph.eachEdge(function (e) {
            if (e.canCollapse) {
                e.entity.stopAnimationAll();
                this._root.removeChild(e.entity.el);
                e.canCollapse = false;
                e.entity = null;
                if (config.enableAnimation) {
                    this._extraEdgeBundle.removeEdge(e);
                }
            }
        }, this);

        this._syncHeaderBarExplorePercent();
        zr.refreshNextFrame();
    }

    /**
     * hover节点的时候展开未展开的节点
     */
    GraphMain.prototype.expandNode = function (node) {
        var zr = this._zr;
        var self = this;

        var logTitle = [];
        for (var i = 0; i < node.edges.length; i++) {
            var e = node.edges[i];
            var other = e.node1 === node ? e.node2 : e.node1;

            // 不出补边
            if (e.isExtra) {
                continue;
            }
            var newNodeEntity = false;
            if (!other.entity) {
                newNodeEntity = true;
                this._createNodeEntity(other);

                logTitle.push(other.id, other.data.layerCounter);

                for (var j = 0, inEdgesLen = other.inEdges.length; j < inEdgesLen; j++) {
                    var inEdge = other.inEdges[j];
                    if (inEdge.node1 === node) {
                        logTitle.push(inEdge.data.id);
                    }
                }
            }
            if (!e.entity) {
                this._createEdgeEntity(e);
            }
            // 在节点是新展开的情况下才显示展开动画
            // 有可能节点在其它节点展开的时候已经绘制，但是边没补上
            if (config.enableAnimation && newNodeEntity) {
                this._growNodeAnimation(other, node, Math.random() * 500);
            }
        }

        var expandedSum = [];
        this._graph.eachNode(function (n, index) {
            if (expandedSum[n.data.layerCounter]) {
                expandedSum[n.data.layerCounter] ++;
            }
            else {
                expandedSum[n.data.layerCounter] = 1;
            }
        });

        if (logTitle.length) {
            bkgLog({
                type: 'zhishitupuexpand',
                target: logTitle.join(','),
                area: 'entity',
                extend: expandedSum.join(',')
            });
        }

        this._syncHeaderBarExplorePercent();
        zr.refreshNextFrame();

        // if (node.outEdges || node.outEdges.length == 0) {
        //     this.showNodeEndTip(node);
        // }
    }

    GraphMain.prototype.toJSON = function () {
        var graph = this._graph;
        var res = {
            viewport: {
                x: 0,
                y: 0,
                width: this._zr.getWidth(),
                height: this._zr.getHeight()
            },
            entities: [],
            relations: []
        };
        graph.eachNode(function (n) {
            n.data.position = n.layout.position;
            res.entities.push(n.data);
        });
        graph.eachEdge(function (e) {
            res.relations.push(e.data);
        });
        return res;
    };

    /**
     * 计算返回当前用户探索百分比
     */
    GraphMain.prototype.getExplorePercent = function () {
        var nodes = this._graph.nodes;
        return (this._nodeEntityCount - this._baseEntityCount) / (nodes.length - this._baseEntityCount);
    };

    GraphMain.prototype._getEdgeByID = function (e) {
        var graph = this._graph;
        for (var i = 0; i < graph.edges.length; i++) {
            if (graph.edges[i].data.id === e) {
                e = graph.edges[i];
                return e;
            }
        }
    };

    // 保存已展开的节点到localStorage
    GraphMain.prototype._loadStorage = function () {
        if (!window.localStorage) {
            return;
        }
        var id = this._mainNode.id;
        var graph = this._graph;

        var bkg = localStorage['BKGraph_expanded'];
        if (!bkg) {
            return;
        }
        bkg = JSON.parse(bkg);
        if (bkg[id]) {
            var obj = bkg[id];
            for (var i = 0; i < obj.entities.length; i++) {
                var node = graph.getNodeById(obj.entities[i]);
                if (node && !node.entity) {
                    this._createNodeEntity(node);
                }
            }
            for (var i = 0; i < obj.relations.length; i++) {
                var relation = obj.relations[i].split(',');
                var edge = graph.getEdge(relation[0], relation[1]);
                if (edge && !edge.entity) {
                    this._createEdgeEntity(edge);
                }
            }
        }

        this._syncHeaderBarExplorePercent();
    };

    // 保存已展开的节点到localStorage
    GraphMain.prototype._saveStorage = function () {
        if (!window.localStorage) {
            return;
        }
        var id = this._mainNode.id;
        var entities = [];
        var relations = [];
        this._graph.eachNode(function (n) {
            if (n.entity) {
                entities.push(n.id);
            }
        });
        this._graph.eachEdge(function (e) {
            if (e.entity) {
                relations.push(e.node1.id + ',' + e.node2.id);
            }
        });
        var bkg = localStorage['BKGraph_expanded'];
        if (!bkg) {
            bkg = {};
        } else {
            bkg = JSON.parse(bkg);
        }
        bkg[id] = {
            entities: entities,
            relations: relations
        };

        localStorage['BKGraph_expanded'] = JSON.stringify(bkg);
    };

    // 从sessionStorage获取浮层数据
    GraphMain.prototype._loadDetailFromStorage = function (key) {
        if (!window.sessionStorage) {
            return;
        }

        var detailData = sessionStorage['BKGraph_detail_data'];
        var result = null;
        if (!detailData) {
            return;
        }
        detailData = JSON.parse(detailData);
        if (detailData[key]) {
            result = detailData[key];
        }

        return result;
    };

    // 保存浮层数据到sessionStorage
    GraphMain.prototype._saveDetailToStorage = function (key, val) {
        if (!window.sessionStorage) {
            return;
        }

        var detailData = sessionStorage['BKGraph_detail_data'];
        if (!detailData) {
            detailData = {};
        }
        else {
            detailData = JSON.parse(detailData);
        }
        detailData[key] = val;

        try {
            sessionStorage['BKGraph_detail_data'] = JSON.stringify(detailData);
        } catch (oException) {
            if(oException.name == 'QuotaExceededError'){
                sessionStorage.removeItem('BKGraph_detail_data');
            }
        }
    };

    GraphMain.prototype._findCircles = function (keywords) {
        function matchRelation (name) {
            for (var i = 0; i < keywords.length; i++) {
                if (name.indexOf(keywords[i]) >= 0) {
                    return true;
                }
            }
            return false;
        }

        var cycles = Cycle.findFromGraph(this._graph, 3);
        var matchCircles = [];

        for (var j = 0; j < cycles.length; j++) {
            var cycle = cycles[j];

            // 最多三条边
            var len = cycle.nodes.length;
            for (var i = 0; i < len; i++) {
                var n1 = cycle.nodes[i];
                var n2 = cycle.nodes[(i + 1) % len];

                var e = this._graph.getEdge(n1, n2) || this._graph.getEdge(n2, n1);
                if (e && matchRelation(e.data.relationName)) {
                    continue;
                }
                break;
            }
            // console.log(cycle.nodes.map(function(n) {return n.data.name}));
            // 环中所有边都符合关键词
            if (i == cycle.nodes.length) {
                matchCircles.push(cycle);

                for (var k = 0; k < cycle.edges.length; k++) {
                    cycle.edges[k].isSpecial = true;
                }
            }

            // matchCircles.push(cycle);
            // console.log(cycle.nodes.map(function (a) {return a.data.name}));
        }

        return matchCircles;
    }

    /**
     * 刚进入时的动画效果
     */
    GraphMain.prototype._entryAnimation = function (cb) {
        var zr = this._zr;
        var self = this;
        var clipShape = new CircleShape({
            style: {
                x: zr.getWidth() / 2,
                y: zr.getHeight() / 2,
                r: 70
            }
        });
        this._root.clipShape = clipShape;
        this._root.modSelf();
        zr.refreshNextFrame();

        zr.animation.animate(clipShape.style)
            .when(1000, {
                r: Math.max(zr.getWidth(), zr.getHeight())
            })
            .during(function () {
                self._root.modSelf();
                zr.refreshNextFrame();
            })
            .done(function () {
                self._root.clipShape = null;
                cb && cb();
            })
            .start();
    }

    /**
     * 同步节点的屏外提示
     */
    GraphMain.prototype._syncOutTipEntities = function () {
        var zr = this._zr;
        var node = this._currentActiveNode;
        if (!node) {
            return;
        }
        var headerBar = this._kgraph.getComponentByType('HEADERBAR');
        var searchBar = this._kgraph.getComponentByType('SEARCHBAR');
        var top = 0;
        var bottom = 0;
        if (headerBar) {
            top = headerBar.el.clientHeight;
        }
        if (searchBar) {
            var bottom = parseInt(util.getStyle(searchBar.el, 'bottom'));
            bottom += searchBar.el.clientHeight;
        }
        var left = -parseInt(util.getStyle(this.el, 'left'));

        var layer0 = this._zr.painter.getLayer(0);
        var rect = {
            x: (-layer0.position[0] + left) / layer0.scale[0],
            y: (-layer0.position[1] + top)/ layer0.scale[1],
            width: (zr.getWidth() - 2 * left) / layer0.scale[0],
            height: (zr.getHeight() - top - bottom) / layer0.scale[1]
        };

        for (var i = 0; i < node.edges.length; i++) {
            var e = node.edges[i];
            var other = e.node1 === node ? e.node2 : e.node1;

            //中心节点不出补边
            if (node.data.layerCounter === 0 && e.isExtra) {
                continue;
            }
            if (!e.entity || !other.entity) {
                continue;
            }
            if (!other.entity.isInsideRect(rect)) {
                // 找出边与屏幕边缘的所有相交点，然后取于other最近的相交点
                var points = e.entity.intersectRect(rect);
                var min = Infinity;
                var point;
                var side;
                for (var k = 0; k < points.length; k++) {
                    var dist = vec2.dist(points[k].point, other.entity.el.position)
                    if (dist < min) {
                        dist = min;
                        point = points[k].point;
                        side = points[k].side;
                    }
                }
                if (side) {
                    if (!other._outTipEntity) {
                        other._outTipEntity = new OutTipEntity({
                            label: other.data.name
                        });
                        other._outTipEntity.initialize(zr);
                        this._root.addChild(other._outTipEntity.el);   
                    }
                    var p = other._outTipEntity.el.position;
                    vec2.copy(p, point);
                    switch (side) {
                        case 'top':
                            break;
                        case 'left':
                            p[0] += 25;
                            break;
                        case 'bottom':
                            p[1] -= 25;
                            break;
                        case 'right':
                            p[0] -= 25;
                            break;
                    }
                    other._outTipEntity.el.modSelf();
                } else if (other._outTipEntity) {
                    // 边与屏幕边缘没有交点
                    this._root.removeChild(other._outTipEntity.el);
                    other._outTipEntity = null;
                }
            } else if (other._outTipEntity) {
                this._root.removeChild(other._outTipEntity.el);
                other._outTipEntity = null;
            }
        }
    }

    GraphMain.prototype._growNodeAnimation = function (toNode, fromNode, delay) {
        var zr = this._zr;
        var e = this._graph.getEdge(fromNode.id, toNode.id) || this._graph.getEdge(toNode.id, fromNode.id);
        var self = this;

        var radius = toNode.entity.radius;
        toNode.entity.setRadius(1);
        this._animating = true;
        zr.refreshNextFrame();
        e.entity.animateLength(zr, 300, 0, fromNode.entity, function () {
            toNode.entity.animateRadius(radius, 500, function () {
                self._animating = false;
                // 方便计算边的顶点
                fromNode.entity.radius = fromNode.layout.size;
                toNode.entity.radius = toNode.layout.size;
                e.entity.update();
            })
        });
    };

    GraphMain.prototype._createNodeEntity = function (node) {
        var zr = this._zr;
        var nodeEntity = new NodeEntity({
            radius: node.layout.size,
            label: node.data.name,
            image: node.data.image,
            draggable: this.draggable,
            states: node === this.getMainNode() ? config.mainNodeStates : config.nodeStates
        });
        nodeEntity.initialize(this._zr);

        vec2.copy(nodeEntity.el.position, node.layout.position);
        var self = this;
        nodeEntity.bind('mouseover', function () {
            if (self._animating) {
                return;
            }
            if (self._lastHoverNode !== node) {

                self.dispatch('mouseover:entity', node.data);

                self.expandNode(node);

                self.showNodeHoverTip(node);

                self.hoverNode(node);

                bkgLog({
                    type: 'zhishitupuhover',
                    target: [node.id, node.data.layerCounter].join(','),
                    area: 'entity'
                });
            }
        });
        nodeEntity.bind('mouseout', function () {
            self.unhoverNode();
        });
        nodeEntity.bind('click', function () {
            self.dispatch('click:entity', node);

            self.hideTip();
            var isClicked = cookies.get('BKGraph_node_click_0') || 0;

            if (!isClicked) {
                cookies.set('BKGraph_node_click_0', node.id, {
                    // 10 years
                    expires: 360 * 24 * 3600 * 10
                });
            }

            bkgLog({
                type: 'zhishitupuclick',
                target: node.id + ',' + node.data.layerCounter,
                area: 'entity'
            });

            if (nodeEntity.getState() !== 'active') {
                self._syncOutTipEntities();
                self.activeNodeAndShowAdjacency(node);
            }
            else {
                self._currentActiveNode = null;
                self.unactiveAll();
                self.hideSidebar();
                return;
            }

            self.showEntityDetail(node, true);
        });
        nodeEntity.bind('dragstart', function () {
            node.layout.fixed = true;
            util.addEventListener(document.body, 'mousemove', onDrag);
        });
        nodeEntity.bind('dragend', function () {
            node.layout.fixed = false;
            util.removeEventListener(document.body, 'mousemove', onDrag);
        });

        var onDrag = function () {
            self.unactiveAll();
            for (var i = 0; i < node.edges.length; i++) {
                if (node.edges[i].entity) {
                    node.edges[i].entity.update();
                }
            }
            if (config.enableAnimation) {
                self._extraEdgeBundle.update(zr);
            }
            vec2.copy(node.layout.position, node.entity.el.position);
            zr.refreshNextFrame();
        }

        node.entity = nodeEntity;
        this._root.addChild(nodeEntity.el);

        this._nodeEntityCount++;
        return nodeEntity;
    };

    GraphMain.prototype._createEdgeEntity = function (e) {
        var self = this;
        var zr = this._zr;
        if (e.node1.entity && e.node2.entity) {
            var edgeEntity = new CurveEdgeEntity({
                sourceEntity: e.node1.entity,
                targetEntity: e.node2.entity,
                label: e.data.relationName,
                layerCounter: Math.max(e.node1.data.layerCounter, e.node2.data.layerCounter),
                isExtra: e.isExtra,
                states: e.isExtra ? config.extraEdgeStates : config.edgeStates
            });
            if (e.isExtra) {
                if (config.enableAnimation) {
                    this._extraEdgeBundle.addEdge(e);
                }
                edgeEntity.hidden = true;
            }

            edgeEntity.initialize(this._zr);

            edgeEntity.bind('click', function () {
                self.dispatch('click:relation', e);

                bkgLog({
                    type: 'zhishitupuclick',
                    target: [
                                // from entity
                                e.node1.id,
                                e.node1.data.layerCounter,
                                // to entity
                                e.node2.id,
                                e.node2.data.layerCounter,
                                e.data.id,
                                e.isExtra ? 1 : 0,
                                e.isSpecial ? 1 : 0
                            ].join(','),
                    area: 'relation'
                });

                if (edgeEntity.getState() != 'active') {
                    this.activeEdge(e);

                    var isClicked = cookies.get('BKGraph_edge_click_0') || 0;
                    if (!isClicked) {
                        self.hideTip();
                        cookies.set('BKGraph_edge_click_0', e.data.id, {
                            // 10 years
                            expires: 360 * 24 * 3600 * 10
                        });
                    }
                }
                else {
                    self.unactiveAll();
                    self.hideSidebar();
                    return;
                }

                this.showRelationDetail(e);

            }, this);
            edgeEntity.bind('mouseover', function () {

                if (self._lastHoverEdge !== e) {
                    self.dispatch('mouseover:relation', e.data);

                    self.hoverEdge(e);
                }

            });
            edgeEntity.bind('mouseout', function () {
                self.unhoverEdge();
            });

            e.entity = edgeEntity;

            this._root.addChild(edgeEntity.el);

            return edgeEntity;
        }
    };

    GraphMain.prototype._updateNodePositions = function () {
        var zr = this._zr;
        // PENDING
        var graph = this._graph;
        for (var i = 0; i < graph.nodes.length; i++) {
            var n = graph.nodes[i];
            if (n.entity) {
                if (n.layout.fixed) {
                    vec2.copy(n.layout.position, n.entity.el.position);
                } else {
                    vec2.copy(n.entity.el.position, n.layout.position);
                }
                zr.modGroup(n.entity.el.id);
            }
        }
        for (var i = 0; i < graph.edges.length; i++) {
            var e = graph.edges[i];
            if (e.entity) {
                e.entity.update(zr);
            }
        }

        if (config.enableAnimation) {
            this._extraEdgeBundle.update(zr);
        }

        zr.refreshNextFrame();
    };

    GraphMain.prototype._syncHeaderBarExplorePercent = function () {
        if (!config.isPlat) {
            this._saveStorage();
        }
    }

    GraphMain.prototype._culling = function () {
        var graph = this._graph;
        var zr = this._zr;
        if (!graph) {
            return;
        }
        var right = -parseInt(util.getStyle(this.el, 'right'));

        var nodeLayer = zr.painter.getLayer(1);
        var width = zr.getWidth();
        var height = zr.getHeight();
        nodeLayer.updateTransform();

        var layer0 = this._zr.painter.getLayer(0);
        var rect = {
            x: -layer0.position[0] / layer0.scale[0],
            y: -layer0.position[1] / layer0.scale[1],
            width: (zr.getWidth() - right) / layer0.scale[0],
            height: zr.getHeight() / layer0.scale[1]
        }

        var imageLoadingCount = 0;
        var imageLoadedCount = 0;

        for (var i = 0; i < graph.nodes.length; i++) {
            var n = graph.nodes[i];
            if (n.entity) {
                n.entity.el.ignore = n.entity.hidden || !n.entity.isInsideRect(rect);
                if (! n.entity.el.ignore) {
                    // 需要统计第一帧中所有图片加载完成的时间
                    if (this._isFirstFrame) {
                        imageLoadingCount++;
                        n.entity.loadImage(
                            zr,
                            // Success
                            function () {
                                imageLoadingCount--;
                                imageLoadedCount++;
                                if (imageLoadingCount === 0) {
                                    bkgLog({
                                        // 首屏渲染完成日志
                                        type: 'zhishitupuscreenrendered',
                                        imageCount: imageLoadedCount
                                    });
                                }
                            },
                            // Error
                            function () {
                                imageLoadingCount--;
                                if (imageLoadingCount === 0) {
                                    bkgLog({
                                        // 首屏渲染完成日志
                                        type: 'zhishitupuscreenrendered',
                                        imageCount: imageLoadedCount
                                    });
                                }
                            }
                        );
                    } else {
                        n.entity.loadImage(zr);
                    }
                }
                vec2.min(this._min, this._min, n.entity.el.position);
                vec2.max(this._max, this._max, n.entity.el.position);
            }
        }
        for (var i = 0; i < graph.edges.length; i++) {
            var e = graph.edges[i];
            if (e.entity) {
                e.entity.el.ignore = e.entity.hidden || !e.entity.isInsideRect(rect);
            }
        }

        this._isFirstFrame = false;
    }

    zrUtil.inherits(GraphMain, Component);

    function _randomInCircle(x, y, radius) {
        var v = vec2.create();
        var angle = Math.random() * Math.PI * 2;
        v[0] = Math.cos(angle) * radius + x;
        v[1] = Math.sin(angle) * radius + y;
        return v;
    }

    return GraphMain;
});