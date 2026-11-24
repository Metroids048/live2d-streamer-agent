package io.github.psd2live.application

import kotlinx.serialization.json.*
import org.umamo.format.art.*
import org.umamo.format.psd.PsdReader
import org.umamo.format.psd.PsdWriter
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import kotlin.math.*

private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
private fun LayerBounds.json() = buildJsonObject { put("left",left);put("top",top);put("width",width);put("height",height) }

// Nearest-neighbour enlargement retains every straight RGBA source value, including RGB under zero alpha.
// It adds no detail. Both output axes must be at least the source size so every source pixel survives.
private fun enlarge(source: LayerRaster,width: Int,height: Int): LayerRaster {
    require(width>=source.width && height>=source.height) { "Source pixels would be downsampled" }
    if(width==source.width && height==source.height)return source
    val bytes=ByteArray(width*height*4)
    for(y in 0 until height)for(x in 0 until width) {
        val sx=min(source.width-1,((x+.5)*source.width/width).toInt())
        val sy=min(source.height-1,((y+.5)*source.height/height).toInt())
        val from=(sy*source.width+sx)*4;val to=(y*width+x)*4
        source.rgba.copyInto(bytes,to,from,from+4)
    }
    return LayerRaster(width,height,bytes)
}

private data class ExportLayer(val original: SourceLayer,override val bounds: LayerBounds,override val raster: LayerRaster): SourceLayer by original

fun main(args: Array<String>) {
    require(args.size==3) { "SourcePsdKt <layout.json> <new-output.psd> <new-readback.json>" }
    val input=Path.of(args[0]).toRealPath();val output=Path.of(args[1]).toAbsolutePath().normalize();val report=Path.of(args[2]).toAbsolutePath().normalize()
    require(!Files.exists(output) && !Files.exists(report)) { "Keep previous outputs; choose new PSD/report paths" }
    val layout=LayoutManifest.read(input);val art=LayoutManifest.source(layout).art
    val density=layout.layers.maxOf { max(it.raster.width/it.rect.width.toDouble(),it.raster.height/it.rect.height.toDouble()) }
    val scale=max(1,ceil(density).toInt())
    val width=layout.width*scale;val height=layout.height*scale
    require(width in 1..30000 && height in 1..30000) { "Highest source density needs a canvas beyond PSD's 30,000-pixel limit" }
    val layers=art.layers.mapIndexed { index,layer ->
        val rect=layout.layers[index].rect
        val bounds=LayerBounds((rect.left*scale).roundToInt(),(rect.top*scale).roundToInt(),
            max(layer.raster.width,(rect.width*scale).roundToInt()),max(layer.raster.height,(rect.height*scale).roundToInt()))
        ExportLayer(layer,bounds,enlarge(layer.raster,bounds.width,bounds.height))
    }
    Files.createDirectories(output.parent);Files.createDirectories(report.parent)
    val encoded=PsdWriter.write(width,height,layers,art.groups)
    Files.write(output,encoded,java.nio.file.StandardOpenOption.CREATE_NEW)
    // Re-read the actual file, not the encoded in-memory buffer.
    val actualBytes=Files.readAllBytes(output);val actual=PsdReader.read(actualBytes)
    require(actual.widthPx==width && actual.heightPx==height && actual.layers.size==layers.size) { "PSD canvas/layer count changed" }
    require(actual.groups.size==art.groups.size) { "PSD group count changed" }
    for(group in art.groups) {
        val read=actual.groups.single { it.path==group.path }
        require(read.visible==group.visible && abs(read.opacity-group.opacity)<=1f/255f) { "PSD group state changed" }
    }
    val rows=layers.mapIndexed { index,expected ->
        val read=actual.layers[index];val source=expected.original.raster;val rect=layout.layers[index].rect
        require(read.name==expected.name && read.groupPath==expected.groupPath && read.visible==expected.visible &&
            abs(read.opacity-expected.opacity)<=1f/255f && read.bounds==expected.bounds && read.blend==expected.blend &&
            read.raster.width==expected.raster.width && read.raster.height==expected.raster.height) { "PSD layer metadata/order changed: ${expected.id.raw}" }
        require(read.raster.rgba.contentEquals(expected.raster.rgba)) { "PSD RGBA bytes changed: ${expected.id.raw}" }
        var mismatched=0;var maximum=0
        for(y in 0 until source.height)for(x in 0 until source.width) {
            val dx=((x+.5)*read.raster.width/source.width-.5).roundToInt().coerceIn(0,read.raster.width-1)
            val dy=((y+.5)*read.raster.height/source.height-.5).roundToInt().coerceIn(0,read.raster.height-1)
            val from=(y*source.width+x)*4;val to=(dy*read.raster.width+dx)*4
            var different=false
            for(channel in 0..3) {
                val delta=abs((source.rgba[from+channel].toInt() and 255)-(read.raster.rgba[to+channel].toInt() and 255))
                maximum=max(maximum,delta);different=different || delta!=0
            }
            if(different)mismatched++
        }
        require(mismatched==0) { "Original source pixel is missing from PSD: ${expected.id.raw}" }
        val geometryError=listOf(abs(read.bounds.left/scale.toDouble()-rect.left),abs(read.bounds.top/scale.toDouble()-rect.top),
            abs(read.bounds.width/scale.toDouble()-rect.width),abs(read.bounds.height/scale.toDouble()-rect.height)).max()
        require(geometryError<=.501/scale) { "Layout quantization exceeded half an output pixel: ${expected.id.raw}" }
        buildJsonObject {
            put("id",expected.id.raw);put("psdLayerId",read.id.raw);put("name",read.name);put("visible",read.visible);put("opacity",read.opacity);put("group",read.groupPath)
            put("sourceWidth",source.width);put("sourceHeight",source.height);put("sourceRgbaSha256",sha(source.rgba))
            put("bounds",read.bounds.json());put("readbackRgbaSha256",sha(read.raster.rgba));put("rgbaRoundTripExact",true)
            put("sourcePixelsChecked",source.width*source.height);put("sourcePixelsMissingOrChanged",mismatched);put("maxSourceChannelError",maximum)
            put("maxLogicalRectError",geometryError);put("rasterScaleX",read.raster.width.toDouble()/source.width);put("rasterScaleY",read.raster.height.toDouble()/source.height)
        }
    }
    val result=buildJsonObject {
        put("schemaVersion",1);put("status","passed");put("scope","Layered source PSD fidelity only; not Artwork quality, rigging, production packaging or user acceptance")
        put("sourceLayout",input.toString());put("sourceLayoutSha256",sha(Files.readAllBytes(input)));put("psd",output.toString());put("psdSha256",sha(actualBytes));put("psdBytes",actualBytes.size)
        put("logicalCanvas",buildJsonObject{put("width",layout.width);put("height",layout.height)})
        put("highestSourcePixelsPerLogicalUnit",density);put("integerCanvasScale",scale);put("psdCanvas",buildJsonObject{put("width",width);put("height",height)})
        put("resampling","nearest-neighbour enlargement only; every original RGBA pixel recoverable with zero channel error; no smart objects, no generated detail")
        put("layerCount",actual.layers.size);put("hiddenLayerCount",actual.layers.count { !it.visible });put("groupCount",actual.groups.size)
        put("groups",JsonArray(actual.groups.map { group -> buildJsonObject { put("path",group.path);put("visible",group.visible);put("opacity",group.opacity) } }))
        put("maxLogicalRectError",rows.maxOf { it["maxLogicalRectError"]!!.jsonPrimitive.double });put("readerWarnings",JsonArray(actual.warnings.map(::JsonPrimitive)))
        put("layers",JsonArray(rows))
        put("limitations",JsonArray(listOf("Lower-density body/source layers are enlarged, not newly detailed.","Nearest-neighbour preserves source values but may look pixelated at high zoom.","PSD uses integer raster coordinates; original floating layout stays authoritative.","Custom layout layer IDs are mapped to PSD numeric IDs in this report.","Writer merged thumbnail uses opaque white and ignores group visibility/opacity; editable layer/group metadata and RGBA are retained.").map(::JsonPrimitive)))
    }
    Files.writeString(report,Json { prettyPrint=true }.encodeToString(JsonElement.serializer(),result)+"\n",java.nio.file.StandardOpenOption.CREATE_NEW)
    println(buildJsonObject {put("status","passed");put("psd",output.toString());put("report",report.toString());put("canvas","${width}x${height}");put("layers",rows.size)})
}
