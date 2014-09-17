(function (){

    var etpl = require( '../../src/main' );
    var readText = require( './readTextSync' );
    var text = readText( 'simpleTarget.text.html' );

    var render = etpl.compile( text['normal'] );
    var renderAutoclose = etpl.getRenderer( 'simpleTarget-autoclose' );

    describe('Simple Target', function() {
        it('should parse correctly when closed manually', function() {
            expect(render({})).toEqual(text.expect);
            expect(render).toBe(etpl.getRenderer('simpleTarget'));
        });

        it('should parse correctly when auto closed', function() {
            expect(renderAutoclose({})).toEqual(text.expect);
            expect(renderAutoclose).toBe(etpl.getRenderer('simpleTarget-autoclose'));
        });

        it('parse empty string should return a renderer which return empty string ""', function() {
            expect(etpl.compile('')()).toEqual('');
        });
    });
    
})();