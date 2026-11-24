package local.reference

import java.io.File
import javax.imageio.ImageIO
import kotlinx.serialization.json.*
import org.umamo.format.moc3.Moc3
import org.umamo.format.cmo3.Cmo3
import org.umamo.format.cmo3.model.custom.CModelSource
import org.umamo.format.cmo3.model.gen.CArtMeshSource
import org.umamo.format.cmo3.model.gen.CArtMeshForm
import org.umamo.format.cmo3.model.gen.CDrawableSourceSet
import org.umamo.interop.moc3.`import`.Moc3Import
import org.umamo.interop.moc3.export.Moc3Export
import org.umamo.interop.cmo3.Cmo3Conversion
import org.umamo.interop.cmo3.Cmo3Import
import org.umamo.interop.cmo3.cmo3AtlasPages
import org.umamo.render.restMeshesToCanvasSpace
import org.umamo.render.canvasToParentSpaceFor
import org.umamo.runtime.model.DrawableId
import org.umamo.runtime.model.Deformer
import org.umamo.format.moc3.MocDocument
import org.umamo.format.moc3.model.WarpDeformer
import org.umamo.format.moc3.model.RotationDeformer
import org.umamo.format.moc3.model.KeyformAxis
import org.umamo.format.moc3.model.KeyformBinding
import org.umamo.runtime.model.PuppetModel
import org.umamo.runtime.model.ParameterId
import org.umamo.runtime.model.RuntimeTarget
import org.umamo.format.moc3.moc.MocVersion
import org.umamo.runtime.model.partByDrawable
import org.umamo.render.eval.CpuDeformationEvaluator
import org.umamo.render.eval.drawableSpaceMapping
import org.umamo.runtime.eval.gridCorners
import org.umamo.runtime.eval.cellsByLinearIndex
import org.umamo.format.cmo3.model.gen.KeyformGridSource
import org.umamo.format.cmo3.model.gen.KeyformOnGrid
import org.umamo.format.art.*
import org.umamo.format.psd.PsdWriter
import org.umamo.format.psd.PsdReader

private fun counts(p: PuppetModel) = buildJsonObject {
    put("parameters", p.parameters.size); put("parts", p.parts.size)
    put("deformers", p.deformers.size); put("drawables", p.drawables.size)
    put("glues", p.glues.size)
    put("vertices", p.drawables.sumOf { (it.mesh?.positions?.size ?: 0) / 2 })
}

private fun meshSources(root: CModelSource) = Cmo3Import.elementsOf(
    (root.drawableSourceSet as? CDrawableSourceSet)?._sources).filterIsInstance<CArtMeshSource>()

// Canvas rest vertices and parent-local keyforms belong to different coordinate spaces.
// Float(parent - canvas) + canvas loses local precision. Preserve the authored CMO
// absolutes; zero is only an in-memory export base, never the editable canvas mesh.
private fun exportPuppet(root: CModelSource): PuppetModel {
    val normal = Cmo3Import.fromModelSource(root)
    val keyed = normal.drawables.filter { it.geometryGrid != null }.map { it.id.raw }.toSet()
    val sources = meshSources(root).filter { Cmo3Import.idStrOf(it.id) in keyed }
    val saved = sources.associateWith { it.positions }
    return try {
        for (source in sources) source.positions = FloatArray((source.positions as FloatArray).size)
        Cmo3Import.fromModelSource(root)
    } finally {
        for ((source, positions) in saved) source.positions = positions
    }
}

// Fresh CMO synthesis needs canvas rest meshes for editable artwork placement.
// Recover keyform absolutes from the SAME source puppet at each CMO grid cell.
// Channel unions may add keys, so resolve their parameter coordinates rather than
// assuming the original and synthesized form pools have the same order or size.
private fun preserveParentKeyforms(root: CModelSource, original: PuppetModel): Int {
    val byId = original.drawables.associateBy { it.id.raw }
    val synthesized = Cmo3Import.fromModelSource(root).drawables.associateBy { it.id.raw }
    var restored = 0
    for (source in meshSources(root)) {
        val drawable = byId.getValue(Cmo3Import.idStrOf(source.id)!!)
        val base = drawable.mesh?.positions ?: continue
        val originalGrid = drawable.geometryGrid ?: continue
        val grid = synthesized.getValue(drawable.id.raw).geometryGrid ?: continue
        val sourceGrid = source.keyformGridSource as? KeyformGridSource ?: continue
        val cells = Cmo3Import.elementsOf(sourceGrid.keyformsOnGrid).filterIsInstance<KeyformOnGrid>()
        val forms = Cmo3Import.elementsOf(source.keyforms).filterIsInstance<CArtMeshForm>()
            .associateBy { Cmo3Import.uuidOf(it.guid) }
        require(cells.size == grid.cells.size) { "CMO grid cells missing for ${drawable.id}" }
        for ((index, cell) in cells.withIndex()) {
            val form = forms.getValue(Cmo3Import.uuidOf(cell.keyformGuid))
            val coordinate = grid.cells[index].coordinate
            val values = grid.axes.mapIndexed { axis, binding ->
                binding.parameterId to binding.keys[coordinate[axis]]
            }.toMap()
            val corners = gridCorners(originalGrid) { id -> values.getValue(id) }
                ?: error("Hidden source keyform for ${drawable.id}")
            val originals = cellsByLinearIndex(originalGrid)
            val match = base.copyOf()
            for (corner in corners) {
                val delta = originals.getValue(corner.linearIndex).form.positionDeltas
                for (component in match.indices) match[component] += corner.weight * delta[component]
            }
            val current = form.positions as FloatArray
            require(match.size == current.size)
            val error = match.indices.maxOf { kotlin.math.abs(match[it] - current[it]) }
            require(error < .002f) { "CMO synthesis changed keyform ${drawable.id}: $error" }
            form.positions = match.copyOf()
            restored++
        }
    }
    return restored
}

// Least-squares neutral canvas -> authored parent coordinates. The engine's
// Newton inverse needs a seed near the old domain for extended artwork.
private fun fitParent(canvas: FloatArray, parent: FloatArray, points: FloatArray): FloatArray {
    fun solve(component: Int): DoubleArray {
        val a = Array(3) { DoubleArray(4) }
        for (i in canvas.indices step 2) {
            val row = doubleArrayOf(canvas[i].toDouble(), canvas[i+1].toDouble(), 1.0)
            for (r in 0..2) { for (c in 0..2) a[r][c] += row[r]*row[c]; a[r][3] += row[r]*parent[i+component] }
        }
        for (c in 0..2) {
            val pivot = (c..2).maxBy { kotlin.math.abs(a[it][c]) }
            val swap = a[c]; a[c] = a[pivot]; a[pivot] = swap
            require(kotlin.math.abs(a[c][c])>1e-12)
            val divisor=a[c][c]; for (j in c..3) a[c][j]/=divisor
            for (r in 0..2) if (r!=c) { val f=a[r][c]; for (j in c..3) a[r][j]-=f*a[c][j] }
        }
        return DoubleArray(3) { a[it][3] }
    }
    val u=solve(0); val v=solve(1)
    return FloatArray(points.size) { i -> val c=if(i%2==0)u else v; val k=i-i%2; (c[0]*points[k]+c[1]*points[k+1]+c[2]).toFloat() }
}

private fun solveParent(puppet: PuppetModel, id: String, rest: FloatArray, parent: FloatArray, points: FloatArray, pose: Map<ParameterId, Float> = emptyMap()): FloatArray {
    val mapping=requireNotNull(drawableSpaceMapping(puppet,pose,DrawableId(id)))
    val seed=fitParent(rest,parent,points)
    val world=FloatArray(points.size){if(it%2==0)points[it] else -points[it]}
    val local=mapping.worldToLocalLinearized(world,seed,mapping.localToWorld(seed),(points.indices step 2).map{it/2}.toSet())
    val projected=mapping.localToWorld(local)
    val error=world.indices.maxOf{kotlin.math.abs(world[it]-projected[it])}
    println("$id neutral inverse max error=$error px")
    require(error<1f){"New mesh does not fit inherited deformer: $id, error $error"}
    return local
}

fun main(args: Array<String>) {
    if (args.getOrNull(2) == "psd") {
        val input=File(args[0]);val spec=Json.parseToJsonElement(input.readText()).jsonObject
        val out=File(args[1]);out.mkdirs()
        val layers=spec["layers"]!!.jsonArray.reversed().map { row ->
            val l=row.jsonObject;val img=ImageIO.read(File(input.parentFile,l["file"]!!.jsonPrimitive.content))
            val rgba=ByteArray(img.width*img.height*4)
            for(y in 0 until img.height)for(x in 0 until img.width){val argb=img.getRGB(x,y);val k=(y*img.width+x)*4
                rgba[k]=(argb ushr 16).toByte();rgba[k+1]=(argb ushr 8).toByte();rgba[k+2]=argb.toByte();rgba[k+3]=(argb ushr 24).toByte()}
            object: SourceLayer {
                override val id=LayerId(l["id"]!!.jsonPrimitive.content)
                override val name=l["name"]!!.jsonPrimitive.content
                override val groupPath=""
                override val order=l["order"]!!.jsonPrimitive.int
                override val bounds=LayerBounds(l["left"]!!.jsonPrimitive.int,l["top"]!!.jsonPrimitive.int,img.width,img.height)
                override val opacity=l["opacity"]!!.jsonPrimitive.float
                override val visible=l["visible"]!!.jsonPrimitive.boolean
                override val clipped=false
                override val blend=LayerBlend.valueOf(l["blend"]!!.jsonPrimitive.content)
                override val raster=LayerRaster(img.width,img.height,rgba)
            }
        }
        val width=spec["width"]!!.jsonPrimitive.int;val height=spec["height"]!!.jsonPrimitive.int
        val file=File(out,"星汐-分层制作素材.psd");require(!file.exists())
        file.writeBytes(PsdWriter.write(width,height,layers))
        val actual=PsdReader.read(file.readBytes());require(actual.layers.size==layers.size)
        for(expected in layers){val read=actual.layers.single{it.name==expected.name}
            require(read.bounds==expected.bounds && read.visible==expected.visible && read.raster.rgba.contentEquals(expected.raster.rgba)){"PSD readback mismatch ${expected.name}"}}
        File(out,"psd-readback.json").writeText(buildJsonObject{put("layers",actual.layers.size);put("width",width);put("height",height);put("rgbaReadbackExact",true);put("source",input.absolutePath);put("scope","Editable neutral-pose projected layers, not hidden-area completion or visual acceptance")}.toString())
        println("PSD exported and read back: ${actual.layers.size} independent layers, ${width}x$height")
        return
    }
    if (args.getOrNull(2) == "reopen") {
        val out = File(args[1]); out.mkdirs()
        val cmo = Cmo3.read(File(args[0]).readBytes())
        val root = cmo.root as CModelSource
        val puppet = exportPuppet(root)
        val textures = cmo3AtlasPages(root, cmo::extractLayerPng)
        textures.pageBytes.forEachIndexed { i, bytes -> File(out, "texture-$i.png").writeBytes(bytes) }
        val textured = puppet.copy(drawables = puppet.drawables.map { it.copy(texturePage = textures.atlasIndexByDrawableId.getValue(it.id.raw)) })
        val lowered = Moc3Export.toMocDocument(textured, version = MocVersion.V50)
        // Preserve flags already present in the recovered reference. V50 has
        // PARAM_REPEAT storage, although the editor's authoring policy strips it.
        val repeatById = textured.parameters.associate { it.id.raw to it.repeat }
        val d = lowered.document
        val retained = MocDocument(d.version, d.canvas,
            d.parameters.map { it.copy(repeats = repeatById.getValue(it.id)) },
            d.bindings.associateBy { it.index }, d.parts, d.deformers, d.artMeshes,
            d.glues, d.renderOrderGroups, d.blendShapes, d.offscreens, d.keyPositionsHasParameterUnion)
        val runtimeBytes = Moc3.write(retained)
        val verified = Moc3.read(runtimeBytes)
        require(verified.parameters.all { it.repeats == repeatById.getValue(it.id) })
        File(out, "recovered.moc3").writeBytes(runtimeBytes)
        File(out, "recovered.model3.json").writeText(buildJsonObject {
            put("Version", 3); put("FileReferences", buildJsonObject {
                put("Moc", "recovered.moc3"); put("Textures", JsonArray(textures.pageBytes.indices.map { JsonPrimitive("texture-$it.png") }))
            })
        }.toString())
        File(out, "reopen-report.json").writeText(buildJsonObject {
            put("counts", counts(textured)); put("texturePages", textures.pageBytes.size)
            put("notices", JsonArray(lowered.report.notices.map { JsonPrimitive(it.toString()) }))
            put("preservedRepeatParameters", JsonArray(verified.parameters.filter { it.repeats }.map { JsonPrimitive(it.id) }))
            put("repeatFlagsReadbackExact", true)
        }.toString())
        println("Reopened CMO3 and exported textured runtime: ${counts(textured)}")
        return
    }
    val manifest = File(args[0]); val out = File(args[1]); out.mkdirs()
    val refs = Json.parseToJsonElement(manifest.readText()).jsonObject["FileReferences"]!!.jsonObject
    fun asset(key: String) = File(manifest.parentFile, refs[key]!!.jsonPrimitive.content)
    val document = Moc3.read(asset("Moc").readBytes())
    File(out, "semantic-roundtrip.moc3").writeBytes(Moc3.write(document))
    println("decoded MOC: ${document.version}")
    val puppet = Moc3Import.fromMocDocument(document, refs["DisplayInfo"]?.let { Moc3.readCdi3(asset("DisplayInfo").readText()) }, compactChannels = false)
    println("imported: ${counts(puppet)}")
    File(out,"mesh-adaptation-metadata.json").writeText(JsonArray(document.artMeshes.mapIndexed { index,m -> buildJsonObject {
        put("id",m.id);put("flags",m.constantFlags);put("part",m.parentPartIndex);put("parent",m.parentDeformerIndex)
        put("keys",m.keyforms.size);put("glued",document.glues.any{it.meshAIndex==index || it.meshBIndex==index})
    }}).toString())
    if(args.getOrNull(2)=="continuous-cloth") {
        val spec=Json.parseToJsonElement(File(args[3]).readText()).jsonObject
        val evaluator=CpuDeformationEvaluator()
        val neutral=evaluator.evaluate(puppet,emptyMap()).worldPositions
        fun band(v:FloatArray,top:Boolean,f:Float):List<Int>{
            val ys=v.filterIndexed{i,_->i%2==1};val lo=ys.min();val hi=ys.max()
            return ys.indices.filter{if(top)ys[it]>hi-(hi-lo)*f else ys[it]<lo+(hi-lo)*f}
        }
        fun center(v:FloatArray,ix:List<Int>)=floatArrayOf(ix.map{v[2*it]}.average().toFloat(),ix.map{v[2*it+1]}.average().toFloat())
        val groups=spec["groups"]!!.jsonArray.map{it.jsonObject}
        val replaced=groups.flatMap{g->listOf(g["upper"]!!.jsonPrimitive.content)+g["lowerTargets"]?.jsonArray.orEmpty().map{it.jsonObject["id"]!!.jsonPrimitive.content}}.toSet()
        val hidden=spec["hide"]!!.jsonArray.map{it.jsonPrimitive.content}.toSet()
        val meshes=document.artMeshes.toMutableList()
        val bindings=document.bindings.associateBy{it.index}.toMutableMap()
        val glues=document.glues.filter{document.artMeshes[it.meshAIndex].id !in replaced && document.artMeshes[it.meshBIndex].id !in replaced}
        val proxyDoc=MocDocument(document.version,document.canvas,document.parameters,bindings,document.parts,document.deformers,
            document.artMeshes.map{m->groups.find{it["upper"]!!.jsonPrimitive.content==m.id}?.let{g->m.copy(parentDeformerIndex=document.deformers.indexOfFirst{it.id==g["parent"]!!.jsonPrimitive.content})}?:m},
            glues,document.renderOrderGroups,document.blendShapes,document.offscreens,document.keyPositionsHasParameterUnion)
        val proxy=Moc3Import.fromMocDocument(proxyDoc,null,compactChannels=false)
        for(g in groups){
            val id=g["upper"]!!.jsonPrimitive.content;val mi=document.artMeshes.indexOfFirst{it.id==id};val m=document.artMeshes[mi]
            val u0=neutral.getValue(DrawableId(id));val shoulder=band(u0,true,.15f);val tip=band(u0,false,.14f)
            val defaults=g["lower"]!!.jsonArray.map{it.jsonPrimitive.content}
            val selectors=g["selectors"]!!.jsonArray.map{it.jsonPrimitive.content}
            val axes=g["axes"]!!.jsonArray.map{r->val a=r.jsonObject;KeyformAxis(document.parameters.indexOfFirst{it.id==a["parameter"]!!.jsonPrimitive.content},a["keys"]!!.jsonArray.map{it.jsonPrimitive.float}.toFloatArray())}
            val bi=(bindings.keys.maxOrNull()?:-1)+1;val binding=KeyformBinding(bi,axes);bindings[bi]=binding
            val rows=40;val columns=8;val vertexCount=(rows+1)*(columns+1)
            val uv=FloatArray(vertexCount*2);val triangles=mutableListOf<Short>()
            for(y in 0..rows)for(x in 0..columns){val vi=y*(columns+1)+x;uv[2*vi]=x.toFloat()/columns;uv[2*vi+1]=1f-y.toFloat()/rows
                if(y<rows&&x<columns)listOf(vi,vi+columns+1,vi+1,vi+1,vi+columns+1,vi+columns+2).forEach{triangles.add(it.toShort())}}
            var maxError=0f
            val lowerTargets=g["lowerTargets"]?.jsonArray.orEmpty().map{it.jsonObject}
            val lowerKeys=lowerTargets.associate{it["id"]!!.jsonPrimitive.content to mutableListOf<org.umamo.format.moc3.model.ArtMeshKeyform>()}
            val keyforms=(0 until binding.gridSize).map{ki->
                val indices=binding.keyIndices(ki);val pose=axes.mapIndexed{i,a->ParameterId(document.parameters[a.parameterIndex].id) to a.keyPositions[indices[i]]}.toMap()
                val world=evaluator.evaluate(puppet,pose).worldPositions
                val upper=world.getValue(DrawableId(id));val s=center(upper,shoulder);val u=center(upper,tip)
                val endpoints=defaults.map{lowerId->val v=world.getValue(DrawableId(lowerId));val rest=neutral.getValue(DrawableId(lowerId));center(v,band(rest,true,.16f)) to center(v,band(rest,false,.14f))}
                val e=endpoints[0].first.copyOf();val w=endpoints[0].second.copyOf()
                for(j in selectors.indices){val mix=(pose[ParameterId(selectors[j])]?:0f).coerceIn(0f,1f);for(c in 0..1){e[c]+=(endpoints[j+1].first[c]-e[c])*mix;w[c]+=(endpoints[j+1].second[c]-w[c])*mix}}
                // One shared hinge and vertex strip, replacing two independently capped pieces.
                val h=floatArrayOf((u[0]+e[0])*.5f,(u[1]+e[1])*.5f)
                // A foreshortened chest pose crosses the projected arm line at
                // neighbouring keys. Keep the cloth bend on its anatomical side
                // while retaining both anchors and the hinge's axial position.
                g["foldSide"]?.jsonPrimitive?.float?.let{side->
                    val dx=w[0]-s[0];val dy=w[1]-s[1];val chord=kotlin.math.hypot(dx,dy).coerceAtLeast(.001f)
                    val nx=side*dy/chord;val ny=-side*dx/chord
                    val ax=h[0]-s[0];val ay=h[1]-s[1]
                    val activation=pose[ParameterId(selectors.last())]?:0f
                    val offset=ax*nx+ay*ny;val floor=chord*.20f
                    val delta=(kotlin.math.sqrt(offset*offset+floor*floor)-offset)*activation
                    h[0]+=nx*delta;h[1]+=ny*delta
                }
                val ul=kotlin.math.hypot(h[0]-s[0],h[1]-s[1]);val fl=kotlin.math.hypot(w[0]-h[0],w[1]-h[1])
                val ux=(h[0]-s[0])/ul;val uy=(h[1]-s[1])/ul;val fx=(w[0]-h[0])/fl;val fy=(w[1]-h[1])/fl
                val tangentDistance=minOf(ul,fl)*(g["bendSpan"]?.jsonPrimitive?.float?:.44f)
                val bendCross=ux*fy-uy*fx
                val angle=kotlin.math.atan2(bendCross,ux*fx+uy*fy)
                val circular=kotlin.math.abs(angle)>.001f
                val radius=if(circular)tangentDistance/kotlin.math.tan(kotlin.math.abs(angle)*.5f)else 0f
                val sign=if(angle>=0f)1f else -1f
                val a=floatArrayOf(h[0]-ux*tangentDistance,h[1]-uy*tangentDistance)
                val b=floatArrayOf(h[0]+fx*tangentDistance,h[1]+fy*tangentDistance)
                val arcCenter=floatArrayOf(a[0]-uy*sign*radius,a[1]+ux*sign*radius)
                val upperLength=ul-tangentDistance
                val arcLength=if(circular)radius*kotlin.math.abs(angle)else 2f*tangentDistance
                val vertices=FloatArray(vertexCount*2)
                val half=g["halfWidth"]!!.jsonPrimitive.float
                val bendInner=if(circular)minOf(half,.55f*radius)else half
                for(y in 0..rows){
                    // Vertex rows retain their anatomical meaning at every key.
                    // The shared row 20 is always the middle of the elbow arc.
                    val distance=when{y<12->upperLength*y/12f;y<=28->upperLength+arcLength*(y-12)/16f;else->upperLength+arcLength+(fl-tangentDistance)*(y-28)/12f}
                    var cx:Float;var cy:Float;var nx:Float;var ny:Float;var innerLimit=bendInner
                    if(distance<upperLength){cx=s[0]+ux*distance;cy=s[1]+uy*distance;nx=-uy;ny=ux;innerLimit=half+(bendInner-half)*(distance/upperLength).let{it*it*(3f-2f*it)}}
                    else if(distance>upperLength+arcLength){val d=distance-upperLength-arcLength;cx=b[0]+fx*d;cy=b[1]+fy*d;nx=-fy;ny=fx;innerLimit=bendInner+(half-bendInner)*(d/(fl-tangentDistance)).let{it*it*(3f-2f*it)}}
                    else{val t=(distance-upperLength)/arcLength
                        if(circular){val turn=angle*t;val cs=kotlin.math.cos(turn);val sn=kotlin.math.sin(turn)
                            val dx=a[0]-arcCenter[0];val dy=a[1]-arcCenter[1]
                            cx=arcCenter[0]+cs*dx-sn*dy;cy=arcCenter[1]+sn*dx+cs*dy
                            val tx=cs*ux-sn*uy;val ty=sn*ux+cs*uy;nx=-ty;ny=tx
                        }else{cx=a[0]+(b[0]-a[0])*t;cy=a[1]+(b[1]-a[1])*t;nx=-uy;ny=ux}
                    }
                    // Taper towards the original cuff; the cuff and hand are not replaced.
                    val bendWeight=kotlin.math.sin(Math.PI*(y-12f).coerceIn(0f,16f)/16f).toFloat()
                    val flex=(kotlin.math.abs(angle)/1.6f).coerceIn(0f,1f)
                    val compression=g["bendCompression"]?.jsonPrimitive?.float?:0f
                    val width=half*(1f-.12f*y/rows)*(1f-compression*flex*bendWeight)
                    for(x in 0..columns){var cross=(2f*x/columns-1f)*width
                        if(cross*bendCross>0f)cross*=innerLimit/half
                        val vi=(y*(columns+1)+x)*2;vertices[vi]=cx+nx*cross;vertices[vi+1]=cy+ny*cross}
                }
                // Deep flexion is a projected overlap, not an in-plane tube bend.
                // Retain the reference bone hinge and a filled upper-sleeve cap.
                val clothFlex=if(g["softCompression"]?.jsonPrimitive?.boolean==true)(kotlin.math.abs(angle)/2.4f).coerceIn(0f,1f) else 0f
                if(g["layeredElbow"]?.jsonPrimitive?.boolean==true){
                    for(y in 0..20){
                        val cap=y>16
                        val theta=(y-16).coerceAtLeast(0)/4f*(Math.PI.toFloat()*.5f)
                        val cx=if(cap)h[0]+ux*half*kotlin.math.sin(theta) else s[0]+(h[0]-s[0])*y/16f
                        val cy=if(cap)h[1]+uy*half*kotlin.math.sin(theta) else s[1]+(h[1]-s[1])*y/16f
                        val width=half*(if(cap)kotlin.math.cos(theta).coerceAtLeast(0f) else 1f)
                        val gathering=kotlin.math.exp(-((y-15f)/3.5f)*((y-15f)/3.5f))*clothFlex
                        for(x in 0..columns){val across=2f*x/columns-1f
                            val inner=1f
                            val cross=across*width*(1f-.14f*gathering*inner)
                            val fold=half*.045f*gathering*kotlin.math.sin(across*Math.PI.toFloat())*(if(cap)kotlin.math.cos(theta).coerceAtLeast(0f) else 1f)
                            val vi=(y*(columns+1)+x)*2
                            vertices[vi]=cx-uy*cross+ux*fold;vertices[vi+1]=cy+ux*cross+uy*fold}
                    }
                }
                val mapping=requireNotNull(drawableSpaceMapping(proxy,pose,DrawableId(id)))
                val local=mapping.worldToLocal(vertices,FloatArray(vertices.size){.5f},(0 until vertexCount).toSet())
                val actual=mapping.localToWorld(local);val error=actual.indices.maxOf{kotlin.math.abs(actual[it]-vertices[it])};maxError=maxOf(error,maxError)
                require(error<.1f){"Continuous sleeve inverse $id key $ki: $error"}
                for(target in lowerTargets){
                    val targetId=target["id"]!!.jsonPrimitive.content;val targetMesh=document.artMeshes.single{it.id==targetId}
                    val endpoint=endpoints[target["endpoint"]!!.jsonPrimitive.int].second
                    val shifted=vertices.copyOf()
                    if(g["layeredElbow"]?.jsonPrimitive?.boolean==true){
                        for(y in 20..40){
                            val cap=y<24;val theta=(24-y).coerceAtLeast(0)/4f*(Math.PI.toFloat()*.5f)
                            val cx=if(cap)h[0]-fx*half*kotlin.math.sin(theta) else h[0]+(w[0]-h[0])*(y-24)/16f
                            val cy=if(cap)h[1]-fy*half*kotlin.math.sin(theta) else h[1]+(w[1]-h[1])*(y-24)/16f
                            val width=half*(if(cap)kotlin.math.cos(theta).coerceAtLeast(0f) else 1f-.12f*(y-24)/16f)
                            val gathering=kotlin.math.exp(-((y-25f)/3.5f)*((y-25f)/3.5f))*clothFlex
                            for(x in 0..columns){val across=2f*x/columns-1f
                                val inner=1f
                                val cross=across*width*(1f-.14f*gathering*inner)
                                val fold=half*.045f*gathering*kotlin.math.sin(across*Math.PI.toFloat())*(if(cap)kotlin.math.cos(theta).coerceAtLeast(0f) else 1f)
                                val vi=(y*(columns+1)+x)*2
                                shifted[vi]=cx-fy*cross-fx*fold;shifted[vi+1]=cy+fx*cross-fy*fold}
                        }
                    }
                    val shiftStart=if(g["layeredElbow"]?.jsonPrimitive?.boolean==true)24 else rows/2
                    for(y in shiftStart..rows){val t=((y-shiftStart).toFloat()/(rows-shiftStart)).let{it*it*(3f-2f*it)}
                        for(x in 0..columns){val vi=(y*(columns+1)+x)*2;shifted[vi]+=(endpoint[0]-w[0])*t;shifted[vi+1]+=(endpoint[1]-w[1])*t}}
                    val childLocal=mapping.worldToLocal(shifted,local,(0 until vertexCount).toSet())
                    val checked=mapping.localToWorld(childLocal);val childError=checked.indices.maxOf{kotlin.math.abs(checked[it]-shifted[it])}
                    require(childError<.1f){"Lower shared sleeve inverse $targetId: $childError"}
                    val activation=target["activation"]!!.jsonPrimitive.content
                    val primary=pose[ParameterId(selectors.last())]?:0f
                    val value=if(activation=="default")selectors.fold(1f){a,selector->a*(1f-(pose[ParameterId(selector)]?:0f))}
                        else (pose[ParameterId(activation)]?:0f)*(if(activation==selectors.last())1f else 1f-primary)
                    lowerKeys.getValue(targetId).add(targetMesh.keyforms.first().copy(vertexPositions=childLocal,opacity=value))
                }
                m.keyforms.first().copy(vertexPositions=local)
            }
            meshes[mi]=m.copy(parentDeformerIndex=proxyDoc.artMeshes[mi].parentDeformerIndex,keyformBindingIndex=bi,keyforms=keyforms,
                vertexUvs=uv,triangleIndices=triangles.toShortArray(),textureIndex=g["textureIndex"]!!.jsonPrimitive.int,constantFlags=4,extendedBlend=0,maskDrawableIndices=intArrayOf())
            if(lowerTargets.isNotEmpty()){
                val first=mutableListOf<Short>();val second=mutableListOf<Short>()
                for(k in triangles.indices step 3){val y=triangles[k].toInt()/(columns+1);val into=if(y<rows/2)first else second;for(j in 0..2)into.add(triangles[k+j])}
                val shared=meshes[mi];meshes[mi]=shared.copy(triangleIndices=first.toShortArray())
                for(target in lowerTargets){val targetId=target["id"]!!.jsonPrimitive.content;val ti=document.artMeshes.indexOfFirst{it.id==targetId}
                    meshes[ti]=shared.copy(id=targetId,parentPartIndex=document.artMeshes[ti].parentPartIndex,triangleIndices=second.toShortArray(),keyforms=lowerKeys.getValue(targetId))}
                println("Shared elbow row retained across original lower-sleeve visibility and draw groups")
            }
            g["splitTarget"]?.jsonPrimitive?.content?.let{targetId->
                val ti=document.artMeshes.indexOfFirst{it.id==targetId};require(ti>=0)
                val shared=meshes[mi]
                val first=mutableListOf<Short>();val second=mutableListOf<Short>()
                for(k in triangles.indices step 3){val y=triangles[k].toInt()/(columns+1);val into=if(y<rows/2)first else second;for(j in 0..2)into.add(triangles[k+j])}
                meshes[mi]=shared.copy(triangleIndices=first.toShortArray())
                meshes[ti]=shared.copy(id=targetId,parentPartIndex=document.artMeshes[ti].parentPartIndex,triangleIndices=second.toShortArray())
                println("Shared elbow row split only for original front/back draw groups: $id / $targetId")
            }
            println("$id continuous shoulder/elbow/wrist: ${keyforms.size} keys, $vertexCount vertices, inverse error $maxError")
        }
        val finalMeshes=meshes.map{if(it.id in hidden)it.copy(keyforms=it.keyforms.map{k->k.copy(opacity=0f)})else it}
        val edited=MocDocument(document.version,document.canvas,document.parameters,bindings,document.parts,document.deformers,finalMeshes,glues,document.renderOrderGroups,document.blendShapes,document.offscreens,document.keyPositionsHasParameterUnion)
        File(out,"continuous.moc3").writeBytes(Moc3.write(edited));File(out,"continuous-spec.json").writeText(spec.toString());return
    }
    if (args.getOrNull(2) == "face-jaw") {
        val ids = setOf("ArtMesh111", "ArtMesh202", "ArtMesh245")
        require(document.artMeshes.count { it.id in ids } == ids.size)
        fun fade(t: Float): Float {
            val s = t.coerceIn(0f, 1f)
            return 1f - s * s * (3f - 2f * s)
        }
        // Measured on the neutral face projection. These two bands are baked
        // pale pixels outside the painted jaw line, expressed in canvas pixels.
        val edgeTrim = listOf(
            110 to 0, 125 to 22, 145 to 31, 175 to 38, 205 to 32, 235 to 26,
            265 to 19, 295 to 15, 315 to 11, 330 to 8, 346 to 0, 422 to 0,
            440 to 11, 465 to 18, 495 to 24, 525 to 31, 555 to 38, 575 to 42,
            595 to 39, 615 to 35, 625 to 26, 638 to 0
        )
        val meshes = document.artMeshes.map { mesh ->
            if (mesh.id !in ids) return@map mesh
            val key = mesh.keyforms.single()
            require(document.keyformBinding(mesh.keyformBindingIndex)!!.axes.isEmpty())
            val mapping = requireNotNull(drawableSpaceMapping(puppet, emptyMap(), DrawableId(mesh.id)))
            val before = mapping.localToWorld(key.vertexPositions)
            val xs = before.filterIndexed { i, _ -> i % 2 == 0 }
            val ys = before.filterIndexed { i, _ -> i % 2 == 1 }
            val center = (xs.max() + xs.min()) / 2f
            val halfWidth = (xs.max() - xs.min()) / 2f
            val bottom = ys.min()
            val height = ys.max() - bottom
            val target = before.copyOf()
            val uv = mesh.vertexUvs.copyOf()
            val vCoordinates = uv.filterIndexed { i, _ -> i % 2 == 1 }
            val vPerPixel = (vCoordinates.max() - vCoordinates.min()) / height
            val triangles = mesh.triangleIndices.map { it.toInt() and 65535 }
            val changed = mutableSetOf<Int>()
            // The original upper face stays pinned. Smooth falloff rounds the jaw
            // and shortens only the tip, before the inherited head turn deformers.
            for (i in xs.indices) {
                val sourceX = xs[i] - xs.min()
                val span = edgeTrim.zipWithNext().firstOrNull { (a, b) -> sourceX >= a.first && sourceX < b.first }
                val trim = if (span == null) 0f else {
                    val (a, b) = span
                    a.second + (b.second - a.second) * (sourceX - a.first) / (b.first - a.first)
                }
                val inset = if (trim == 0f) 0f else {
                    // Re-sample the painted contour at the mesh edge. Fade
                    // the UV correction before it reaches the mouth region.
                    val edge = triangles.indices.minOf { j ->
                        val a = triangles[j]
                        val b = triangles[j - j % 3 + (j + 1) % 3]
                        if (xs[a] == xs[b] || xs[i] !in minOf(xs[a], xs[b])..maxOf(xs[a], xs[b]))
                            Float.POSITIVE_INFINITY
                        else ys[a] + (ys[b] - ys[a]) * (xs[i] - xs[a]) / (xs[b] - xs[a])
                    }
                    trim * fade((ys[i] - edge) / 112f)
                }
                val depth = (ys[i] - bottom) / height
                if (depth >= .42f) continue
                val x = xs[i] - center
                // MOC stores atlas V down; Cubism Core exposes it up.
                uv[2 * i + 1] -= inset * vPerPixel
                target[2 * i] += x * .14f * fade(depth / .42f)
                // Keep a soft taper toward the chin as the outline moves out
                // of the pale border. Leaving the full outer hull looks square.
                target[2 * i + 1] += inset * .57f + height * .017f * fade(depth / .18f) *
                    fade(kotlin.math.abs(x) / (halfWidth * .57f))
                changed.add(i)
            }
            var local = key.vertexPositions
            for (step in 1..8) {
                val intermediate = FloatArray(before.size) { i -> before[i] + (target[i] - before[i]) * step / 8f }
                local = mapping.worldToLocalLinearized(intermediate, local, before, changed)
            }
            val actual = mapping.localToWorld(local)
            val error = actual.indices.maxOf { kotlin.math.abs(actual[it] - target[it]) }
            require(error < .1f) { "${mesh.id} jaw target missed by $error px" }
            println("${mesh.id} rounded jaw: ${changed.size} vertices, inverse error $error px")
            mesh.copy(keyforms = listOf(key.copy(vertexPositions = local)), vertexUvs = uv)
        }
        val edited = MocDocument(document.version, document.canvas, document.parameters, document.bindings.associateBy { it.index },
            document.parts, document.deformers, meshes, document.glues, document.renderOrderGroups,
            document.blendShapes, document.offscreens, document.keyPositionsHasParameterUnion)
        File(out, "face-jaw.moc3").writeBytes(Moc3.write(edited))
        return
    }
    if(args.getOrNull(2)=="pose-sculpt") {
        val spec=Json.parseToJsonElement(File(args[3]).readText()).jsonObject
        val bindings=document.bindings.associateBy{it.index}.toMutableMap()
        val parameter=spec["parameter"]!!.jsonPrimitive.content
        val pi=document.parameters.indexOfFirst{it.id==parameter}
        require(pi>=0)
        val positions=spec["keys"]!!.jsonArray.map{it.jsonPrimitive.float}.toFloatArray()
        val ids=spec["meshes"]!!.jsonArray.map{it.jsonPrimitive.content}.toSet()
        val sculpts=spec["sculpts"]!!.jsonArray.map{it.jsonObject}
        val edited=document.artMeshes.map{m->if(m.id !in ids)m else {
            val oldBinding=document.keyformBinding(m.keyformBindingIndex)!!
            require(oldBinding.axes.none{it.parameterIndex==pi})
            val originals=m.keyforms
            val gates=sculpts.map{s->
                val affectsMesh=s["contours"]?.jsonObject?.containsKey(m.id)==true ||
                    (s["handles"]!!.jsonArray.isNotEmpty() && s["handleMeshes"]?.jsonArray?.none{it.jsonPrimitive.content==m.id}!=true)
                if(affectsMesh)s["gate"]?.jsonObject else null
            }
            val gateAxes=gates.filterNotNull().map{g->
                val index=document.parameters.indexOfFirst{it.id==g["parameter"]!!.jsonPrimitive.content}
                val keys=g["keys"]!!.jsonArray.map{it.jsonPrimitive.float}.toFloatArray()
                require(index>=0 && index!=pi && oldBinding.axes.none{it.parameterIndex==index})
                require(keys.isNotEmpty() && keys.size==g["weights"]!!.jsonArray.size && (1 until keys.size).all{keys[it-1]<keys[it]})
                KeyformAxis(index,keys)
            }
            require(gateAxes.distinctBy{it.parameterIndex}.size==gateAxes.size)
            var nextGate=oldBinding.axes.size+1
            val gateIndices=gates.map{if(it==null)-1 else nextGate++}
            // Author each correction at its actual failed pose. Deltas remain in
            // the original parent space, so wrist/shoulder rotations are retained.
            val deltas=originals.mapIndexed{oldIndex,original->sculpts.map{s->
                val pose=s["pose"]!!.jsonObject.map{(id,v)->ParameterId(id) to v.jsonPrimitive.float}.toMap().toMutableMap()
                val oldIndices=oldBinding.keyIndices(oldIndex)
                oldBinding.axes.forEachIndexed{i,a->pose[ParameterId(document.parameters[a.parameterIndex].id)]=a.keyPositions[oldIndices[i]]}
                val mapping=requireNotNull(drawableSpaceMapping(puppet,pose,DrawableId(m.id)))
                val before=mapping.localToWorld(original.vertexPositions)
                val target=before.copyOf();val changed=mutableSetOf<Int>()
                // Explicit silhouette edits use a harmonic interior. Unedited
                // boundary vertices pin the cuff and the upper sleeve seam.
                s["contours"]?.jsonObject?.get(m.id)?.jsonArray?.let{rows->
                    val n=before.size/2;val neighbors=Array(n){mutableSetOf<Int>()}
                    val edges=mutableMapOf<Pair<Int,Int>,Int>()
                    val triangles=m.triangleIndices
                    for(k in triangles.indices step 3)for(j in 0..2){
                        val a=triangles[k+j].toInt() and 65535;val b=triangles[k+(j+1)%3].toInt() and 65535
                        neighbors[a].add(b);neighbors[b].add(a)
                        val e=minOf(a,b) to maxOf(a,b);edges[e]=(edges[e]?:0)+1
                    }
                    val pinned=edges.filterValues{it==1}.keys.flatMap{listOf(it.first,it.second)}.toSet()
                    val delta=FloatArray(before.size)
                    for(row in rows){val v=row.jsonArray;val i=v[0].jsonPrimitive.int
                        require(i in pinned){"Contour target must be a boundary vertex: ${m.id} $i"}
                        delta[i*2]=v[1].jsonPrimitive.float;delta[i*2+1]=-v[2].jsonPrimitive.float
                    }
                    repeat(800){for(i in 0 until n)if(i !in pinned && neighbors[i].isNotEmpty())for(c in 0..1)
                        delta[i*2+c]=neighbors[i].map{delta[it*2+c]}.average().toFloat()
                    }
                    for(i in 0 until n)if(kotlin.math.abs(delta[i*2])+kotlin.math.abs(delta[i*2+1])>.0001f){
                        target[i*2]+=delta[i*2];target[i*2+1]+=delta[i*2+1];changed.add(i)
                    }
                }
                for(i in before.indices step 2){
                    for(h in s["handles"]!!.jsonArray){
                        if(s["handleMeshes"]?.jsonArray?.none{it.jsonPrimitive.content==m.id}==true)continue
                        val v=h.jsonArray.map{it.jsonPrimitive.float}
                        val dx=before[i]-v[0];val dy=-before[i+1]-v[1]
                        val r2=(dx*dx+dy*dy)/(v[4]*v[4])
                        if(r2<1f){val w=(1f-r2)*(1f-r2)*(1f-r2)
                            target[i]+=v[2]*w;target[i+1]-=v[3]*w;changed.add(i/2)
                        }
                    }
                }
                var local=original.vertexPositions.copyOf()
                for(step in 1..32){
                    val intermediate=FloatArray(target.size){j->before[j]+(target[j]-before[j])*step/32f}
                    local=mapping.worldToLocalLinearized(intermediate,local,before,changed)
                }
                val actual=mapping.localToWorld(local)
                val error=changed.maxOfOrNull{i->maxOf(kotlin.math.abs(actual[2*i]-target[2*i]),kotlin.math.abs(actual[2*i+1]-target[2*i+1]))}?:0f
                require(error<.1f){"Authored target cannot be reached: ${m.id} ${s["name"]}: $error px"}
                println("${m.id} ${s["name"]}: ${changed.size} vertices; inverseError=$error")
                FloatArray(local.size){j->local[j]-original.vertexPositions[j]}
            }}
            val index=(bindings.keys.maxOrNull()?:-1)+1
            val binding=KeyformBinding(index,oldBinding.axes+KeyformAxis(pi,positions)+gateAxes);bindings[index]=binding
            val keys=(0 until binding.gridSize).map{k->
                val oldIndex=k%oldBinding.gridSize;val original=originals[oldIndex]
                val indices=binding.keyIndices(k)
                val sculptIndex=indices[oldBinding.axes.size]
                val weights=sculpts.indices.map{s->
                    val gateWeight=gates[s]?.get("weights")?.jsonArray?.get(indices[gateIndices[s]])?.jsonPrimitive?.float?:1f
                    sculpts[s]["weights"]!!.jsonArray[sculptIndex].jsonPrimitive.float*gateWeight
                }
                original.copy(vertexPositions=FloatArray(original.vertexPositions.size){j->
                    original.vertexPositions[j]+sculpts.indices.sumOf{s->(deltas[oldIndex][s][j]*weights[s]).toDouble()}.toFloat()
                })
            }
            m.copy(keyformBindingIndex=index,keyforms=keys)
        }}
        val result=MocDocument(document.version,document.canvas,document.parameters,bindings,document.parts,document.deformers,edited,document.glues,document.renderOrderGroups,document.blendShapes,document.offscreens,document.keyPositionsHasParameterUnion)
        File(out,"sculpt.moc3").writeBytes(Moc3.write(result))
        File(out,"sculpt-spec.json").writeText(spec.toString())
        println("Wrote pose-authored sleeve shapes; source topology, rotations, opacity and motion files retained")
        return
    }
    if(args.getOrNull(2)=="cloth-keyforms") {
        val spec=Json.parseToJsonElement(File(args[3]).readText()).jsonObject
        val evaluator=CpuDeformationEvaluator()
        val neutral=evaluator.evaluate(puppet,emptyMap()).worldPositions
        val bindings=document.bindings.associateBy{it.index}.toMutableMap()
        fun world(id:String,pose:Map<ParameterId,Float>)=evaluator.evaluate(puppet,pose).worldPositions.getValue(DrawableId(id))
        fun center(v:FloatArray,indices:List<Int>)=floatArrayOf(indices.map{v[it*2]}.average().toFloat(),indices.map{v[it*2+1]}.average().toFloat())
        fun band(v:FloatArray,low:Boolean,fraction:Float):List<Int> {
            val ys=v.filterIndexed{i,_->i%2==1};val lo=ys.min();val hi=ys.max()
            // Runtime world Y points up; the authored neutral elbow is the top of a forearm.
            return ys.indices.filter{if(low)ys[it]<lo+(hi-lo)*fraction else ys[it]>hi-(hi-lo)*fraction}
        }
        val corrections=spec["groups"]!!.jsonArray.flatMap{row->
            val g=row.jsonObject;val referenceId=g["lower"]!!.jsonPrimitive.content;val upperId=g["upper"]!!.jsonPrimitive.content
            val lower0=neutral.getValue(DrawableId(referenceId));val upper0=neutral.getValue(DrawableId(upperId))
            val elbowIndices=band(lower0,false,.16f);val wristIndices=band(lower0,true,.14f)
            val upperTipIndices=band(upper0,true,.14f);val shoulderIndices=band(upper0,false,.15f)
            val e0=center(lower0,elbowIndices);val w0=center(lower0,wristIndices)
            val u0=center(upper0,upperTipIndices);val s0=center(upper0,shoulderIndices)
            val ul0=kotlin.math.hypot(u0[0]-s0[0],u0[1]-s0[1]);val ux0=(u0[0]-s0[0])/ul0;val uy0=(u0[1]-s0[1])/ul0
            val along=(e0[0]-u0[0])*ux0+(e0[1]-u0[1])*uy0;val side=-(e0[0]-u0[0])*uy0+(e0[1]-u0[1])*ux0
            val dx=w0[0]-e0[0];val dy=w0[1]-e0[1];val length2=dx*dx+dy*dy
            val parameter=g["bend"]!!.jsonPrimitive.content;val strength=g["strength"]!!.jsonPrimitive.float
            val compression=g["compression"]?.jsonPrimitive?.float?:0f
            val turn=g["turn"]?.jsonPrimitive?.float?:0f
            val upperCloth=g["upperCloth"]?.jsonPrimitive?.boolean?:false
            val curve=g["curve"]?.jsonPrimitive?.float?:0f
            val extraAxes=g["axes"]!!.jsonArray.map{r->val a=r.jsonObject;KeyformAxis(document.parameters.indexOfFirst{it.id==a["parameter"]!!.jsonPrimitive.content},a["keys"]!!.jsonArray.map{it.jsonPrimitive.float}.toFloatArray())}
            g["meshes"]!!.jsonArray.map{it.jsonPrimitive.content}.map{id->
                val m=document.artMeshes.single{it.id==id};val oldBinding=document.keyformBinding(m.keyformBindingIndex)!!
                require(oldBinding.axes.none{a->extraAxes.any{it.parameterIndex==a.parameterIndex}})
                val index=(bindings.keys.maxOrNull()?:-1)+1;val binding=KeyformBinding(index,oldBinding.axes+extraAxes);bindings[index]=binding
                val rest=neutral.getValue(DrawableId(id))
                val weights=(rest.indices step 2).map{i->
                    val t=if(upperCloth)((rest[i]-s0[0])*ux0+(rest[i+1]-s0[1])*uy0)/ul0
                        else ((rest[i]-e0[0])*dx+(rest[i+1]-e0[1])*dy)/length2
                    val q=(if(upperCloth)(t-.35f)/.65f else (.52f-t)/.52f).coerceIn(0f,1f);if(curve>0f)1f else q*q*(3f-2f*q)
                }
                var maxShift=0f
                val keys=(0 until binding.gridSize).map{keyIndex->
                    val keyIndices=binding.keyIndices(keyIndex)
                    val pose=binding.axes.mapIndexed{i,a->ParameterId(document.parameters[a.parameterIndex].id) to a.keyPositions[keyIndices[i]]}.toMap()
                    val oldIndex=keyIndex%oldBinding.gridSize;val old=m.keyforms[oldIndex]
                    val bend=pose.getValue(ParameterId(parameter));var blend=(kotlin.math.abs(bend)/.7f).coerceIn(0f,1f).let{it*it*(3f-2f*it)}*strength
                    if(blend==0f) old else {
                        val lower=world(referenceId,pose);val upper=world(upperId,pose)
                        val mapping=requireNotNull(drawableSpaceMapping(puppet,pose,DrawableId(id)))
                        // ArtMesh keyforms precede glue evaluation. Do not bake a second copy
                        // of the existing glue displacement into its input vertices.
                        val current=mapping.localToWorld(old.vertexPositions)
                        val e=center(lower,elbowIndices);val u=center(upper,upperTipIndices);val s=center(upper,shoulderIndices)
                        val w=center(lower,wristIndices)
                        g["alternateLower"]?.jsonPrimitive?.content?.let{alternateId->
                            val alternate0=neutral.getValue(DrawableId(alternateId))
                            val alternate=world(alternateId,pose)
                            val ae=center(alternate,band(alternate0,false,.16f));val aw=center(alternate,band(alternate0,true,.14f))
                            val selector=pose[ParameterId(g["selector"]!!.jsonPrimitive.content)]?:0f
                            val mix=selector.coerceIn(0f,1f).let{it*it*(3f-2f*it)}
                            for(j in 0..1){e[j]+=(ae[j]-e[j])*mix;w[j]+=(aw[j]-w[j])*mix}
                        }
                        g["defaultLower"]?.jsonPrimitive?.content?.let{defaultId->
                            val default0=neutral.getValue(DrawableId(defaultId));val default=world(defaultId,pose)
                            val de=center(default,band(default0,false,.16f));val dw=center(default,band(default0,true,.14f))
                            val active=g["activeSelectors"]!!.jsonArray.maxOf{pose[ParameterId(it.jsonPrimitive.content)]?:0f}.coerceIn(0f,1f).let{it*it*(3f-2f*it)}
                            for(j in 0..1){e[j]=de[j]+(e[j]-de[j])*active;w[j]=dw[j]+(w[j]-dw[j])*active}
                            val idleStrength=g["defaultStrength"]?.jsonPrimitive?.float?:.125f
                            blend*=idleStrength+(1f-idleStrength)*active
                        }
                        val ul=kotlin.math.hypot(u[0]-s[0],u[1]-s[1]);val ux=(u[0]-s[0])/ul;val uy=(u[1]-s[1])/ul
                        val tx=u[0]+ux*along-uy*side;val ty=u[1]+uy*along+ux*side
                        val fl=kotlin.math.hypot(w[0]-e[0],w[1]-e[1]);val fx=(w[0]-e[0])/fl;val fy=(w[1]-e[1])/fl
                        val innerSign=if((-fy*(s[0]-e[0])+fx*(s[1]-e[1]))>=0f)1f else -1f
                        val target=current.copyOf();val changed=mutableSetOf<Int>()
                        for(i in weights.indices)if(weights[i]>0f){
                            if(g["sharedBulge"]?.jsonPrimitive?.boolean==true){
                                // One world-space field for both overlapping sleeve pieces.
                                // Independent hinge origins can pull their silhouettes apart.
                                val hx=(tx+e[0])*.5f;val hy=(ty+e[1])*.5f
                                val ix=-ux+fx;val iy=-uy+fy
                                val il=kotlin.math.hypot(ix,iy).coerceAtLeast(.001f)
                                val nx=ix/il;val ny=iy/il
                                val vx=current[2*i]-hx;val vy=current[2*i+1]-hy
                                val volume=g["sharedVolume"]?.jsonPrimitive?.boolean==true
                                val radius=minOf(ul,fl)*(if(volume)1.15f else g["sharedGather"]?.jsonPrimitive?.boolean?.let{if(it).85f else .58f}?:.58f)
                                val rr=(vx*vx+vy*vy)/(radius*radius)
                                if(rr<1f){
                                    val falloff=if(volume)(1f-rr)*(1f-rr) else (1f-rr)*(1f-rr)*(1f-rr)
                                    val q=vx*nx+vy*ny;val across=-vx*ny+vy*nx
                                    val bendAmount=((1f-ux*fx-uy*fy)*.5f).coerceIn(0f,1f)
                                    val gain=blend*bendAmount*falloff
                                    // Longer sleeves gather on the inside of a bend, while
                                    // the outside retains volume; both pieces use this same field.
                                    val gather=g["sharedGather"]?.jsonPrimitive?.boolean==true
                                    val roundOuter=g["roundOuter"]?.jsonPrimitive?.boolean==true
                                    val axial=if(roundOuter && q<0f).65f else if(roundOuter).30f else if(volume && q<0f)-.55f else if(volume).50f else if(gather && q<0f)-.10f else if(gather).30f else .16f
                                    val spread=if(volume).32f else if(gather).16f else .10f
                                    target[2*i]+=(-nx*q*axial-ny*across*spread)*gain
                                    target[2*i+1]+=(-ny*q*axial+nx*across*spread)*gain
                                    val foreshorten=g["elbowForeshorten"]?.jsonPrimitive?.float?:0f
                                    if(foreshorten!=0f){
                                        // Move the cloth's elbow toward the wrist as it folds
                                        // forward. One field moves both pieces, while its two
                                        // endpoint factors retain the shoulder and wrist.
                                        val shoulderDistance=kotlin.math.hypot(current[2*i]-s[0],current[2*i+1]-s[1])/ul
                                        val wristDistance=kotlin.math.hypot(current[2*i]-w[0],current[2*i+1]-w[1])/fl
                                        val pin=minOf(1f,shoulderDistance*shoulderDistance*4f)*minOf(1f,wristDistance*wristDistance*4f)
                                        target[2*i]+=fx*fl*foreshorten*gain*pin
                                        target[2*i+1]+=fy*fl*foreshorten*gain*pin
                                    }
                                }
                            }else if(curve>0f){
                                // Round the cloth across the hinge with one tangent field on
                                // both sleeve pieces; retain the authored wrist and shoulder.
                                val radius=minOf(ul,fl)*curve
                                val ax=if(upperCloth)ux else fx;val ay=if(upperCloth)uy else fy
                                val join=g["join"]?.jsonPrimitive?.float?:0f
                                val ox=if(upperCloth)u[0]+(tx-u[0])*join else e[0];val oy=if(upperCloth)u[1]+(ty-u[1])*join else e[1]
                                val vx=current[2*i]-ox;val vy=current[2*i+1]-oy
                                val alongNow=vx*ax+vy*ay;val crossNow=-ay*vx+ax*vy
                                val t=(.5f+alongNow/(2f*radius)).coerceIn(0f,1f)
                                if(t>0f && t<1f){
                                    val a=1f-t
                                    val cx=-a*a*ux*radius+t*t*fx*radius
                                    val cy=-a*a*uy*radius+t*t*fy*radius
                                    val tangentX=a*ux+t*fx;val tangentY=a*uy+t*fy
                                    val tangentLength=kotlin.math.hypot(tangentX,tangentY).coerceAtLeast(.05f)
                                    val nx=-tangentY/tangentLength;val ny=tangentX/tangentLength
                                    // Preserve outer cloth volume; compress only the inside of
                                    // the tight bend so the fillet does not turn inside out.
                                    val bendSide=if(ux*fy-uy*fx>0f)1f else -1f
                                    val inside=(crossNow*bendSide>0f)
                                    val widthScale=if(inside)maxOf(.25f,tangentLength) else 1f
                                    val taper=4f*t*(1f-t)
                                    val joinX=(if(upperCloth)e[0]-tx else tx-e[0])*.5f*join*taper
                                    val joinY=(if(upperCloth)e[1]-ty else ty-e[1])*.5f*join*taper
                                    target[2*i]+=(cx-ax*alongNow+(nx*widthScale+ay)*crossNow+joinX)*blend
                                    target[2*i+1]+=(cy-ay*alongNow+(ny*widthScale-ax)*crossNow+joinY)*blend
                                }
                            }else if(upperCloth){
                                val angle=kotlin.math.atan2(ux*fy-uy*fx,ux*fx+uy*fy)*turn*blend*weights[i]
                                val ca=kotlin.math.cos(angle);val sa=kotlin.math.sin(angle)
                                val vx=current[2*i]-u[0];val vy=current[2*i+1]-u[1]
                                target[2*i]+=(e[0]-tx)*blend*weights[i]*.15f+vx*(ca-1f)-vy*sa
                                target[2*i+1]+=(e[1]-ty)*blend*weights[i]*.15f+vx*sa+vy*(ca-1f)
                            }else{
                                val cross=-fy*(current[2*i]-e[0])+fx*(current[2*i+1]-e[1])
                                val axial=fx*(current[2*i]-e[0])+fy*(current[2*i+1]-e[1])
                                val squeeze=cross*compression*blend*weights[i]*(if(cross*innerSign>0f)1f else .35f)
                                val tuck=(-axial).coerceAtLeast(0f)*compression*blend*weights[i]
                                val angle=kotlin.math.atan2(fx*uy-fy*ux,fx*ux+fy*uy)*turn*blend*weights[i]
                                val ca=kotlin.math.cos(angle);val sa=kotlin.math.sin(angle)
                                val vx=current[2*i]-e[0];val vy=current[2*i+1]-e[1]
                                target[2*i]+=(tx-e[0])*blend*weights[i]+fy*squeeze+fx*tuck+vx*(ca-1f)-vy*sa
                                target[2*i+1]+=(ty-e[1])*blend*weights[i]-fx*squeeze+fy*tuck+vx*sa+vy*(ca-1f)
                            }
                            changed.add(i)
                            maxShift=maxOf(maxShift,kotlin.math.hypot(target[2*i]-current[2*i],target[2*i+1]-current[2*i+1]))
                        }
                        fun area(v:FloatArray,k:Int):Float {
                            val a=m.triangleIndices[k].toInt()*2;val b=m.triangleIndices[k+1].toInt()*2;val c=m.triangleIndices[k+2].toInt()*2
                            return (v[b]-v[a])*(v[c+1]-v[a+1])-(v[b+1]-v[a+1])*(v[c]-v[a])
                        }
                        // A single scale preserves the smooth correction field. Per-triangle
                        // vertex backoff creates a new kink on the surrounding cloth.
                        repeat(48){
                            val unsafe=(m.triangleIndices.indices step 3).any{k->
                                val before=area(current,k);val after=area(target,k)
                                kotlin.math.abs(before)>.001f && before*after<=before*before*.20f
                            }
                            if(unsafe) for(i in changed){target[2*i]=current[2*i]+(target[2*i]-current[2*i])*.85f;target[2*i+1]=current[2*i+1]+(target[2*i+1]-current[2*i+1])*.85f}
                        }
                        val startWorld=mapping.localToWorld(old.vertexPositions)
                        var local=old.vertexPositions.copyOf()
                        var error=Float.POSITIVE_INFINITY
                        for(attempt in 0..24){
                            local=old.vertexPositions.copyOf()
                            // Stay on the authored inverse branch. A target beyond a narrow
                            // overlay cage is backed off as one field, never per triangle.
                            for(step in 1..24){
                                val intermediate=FloatArray(target.size){j->startWorld[j]+(target[j]-startWorld[j])*step/24f}
                                local=mapping.worldToLocalLinearized(intermediate,local,startWorld,changed)
                            }
                            val projected=mapping.localToWorld(local)
                            error=changed.maxOfOrNull{i->maxOf(kotlin.math.abs(target[2*i]-projected[2*i]),kotlin.math.abs(target[2*i+1]-projected[2*i+1]))}?:0f
                            if(error<.1f)break
                            for(i in changed){target[2*i]=current[2*i]+(target[2*i]-current[2*i])*.85f;target[2*i+1]=current[2*i+1]+(target[2*i+1]-current[2*i+1])*.85f}
                        }
                        require(error<.1f){"Cloth inverse error $id key $keyIndex: $error"}
                        old.copy(vertexPositions=local)
                    }
                }
                println("$id cloth keyforms=${keys.size} maxElbowShift=$maxShift; distal wrist vertices retained")
                m.copy(keyformBindingIndex=index,keyforms=keys)
            }
        }.associateBy{it.id}
        // Paired overlay vertices must receive the same pre-glue displacement as
        // the sleeve beneath them. Independent fields otherwise split at partial weights.
        val pairedCorrections=corrections.toMutableMap()
        for(glue in document.glues){
            val source=document.artMeshes[glue.meshAIndex];val overlay=document.artMeshes[glue.meshBIndex]
            if(source.id!="ArtMesh628")continue
            val sourceNew=corrections[source.id]?:continue;val overlayNew=corrections[overlay.id]?:continue
            val ab=bindings.getValue(sourceNew.keyformBindingIndex);val bb=bindings.getValue(overlayNew.keyformBindingIndex)
            require(ab.axes.size==bb.axes.size && ab.axes.indices.all{i->ab.axes[i].parameterIndex==bb.axes[i].parameterIndex && ab.axes[i].keyPositions.contentEquals(bb.axes[i].keyPositions)})
            val oldA=document.keyformBinding(source.keyformBindingIndex)!!;val oldB=document.keyformBinding(overlay.keyformBindingIndex)!!
            val keys=overlayNew.keyforms.mapIndexed{keyIndex,key->
                val indices=bb.keyIndices(keyIndex)
                val pose=bb.axes.mapIndexed{i,axis->ParameterId(document.parameters[axis.parameterIndex].id) to axis.keyPositions[indices[i]]}.toMap()
                val am=requireNotNull(drawableSpaceMapping(puppet,pose,DrawableId(source.id)))
                val bm=requireNotNull(drawableSpaceMapping(puppet,pose,DrawableId(overlay.id)))
                val beforeA=am.localToWorld(source.keyforms[keyIndex%oldA.gridSize].vertexPositions)
                val afterA=am.localToWorld(sourceNew.keyforms[keyIndex].vertexPositions)
                val old=overlay.keyforms[keyIndex%oldB.gridSize];val beforeB=bm.localToWorld(old.vertexPositions);val target=beforeB.copyOf()
                val changed=mutableSetOf<Int>()
                for(pair in glue.pairs){
                    val ai=pair.vertexA;val bi=pair.vertexB
                    target[bi*2]+=afterA[ai*2]-beforeA[ai*2];target[bi*2+1]+=afterA[ai*2+1]-beforeA[ai*2+1];changed.add(bi)
                }
                var local=old.vertexPositions.copyOf()
                for(step in 1..12){val intermediate=FloatArray(target.size){j->beforeB[j]+(target[j]-beforeB[j])*step/12f};local=bm.worldToLocalLinearized(intermediate,local,beforeB,changed)}
                key.copy(vertexPositions=local)
            }
            pairedCorrections[overlay.id]=overlayNew.copy(keyforms=keys)
            println("${overlay.id} paired cloth displacement follows ${source.id} before unchanged glue")
        }
        val edited=MocDocument(document.version,document.canvas,document.parameters,bindings,document.parts,document.deformers,document.artMeshes.map{pairedCorrections[it.id]?:it},document.glues,document.renderOrderGroups,document.blendShapes,document.offscreens,document.keyPositionsHasParameterUnion)
        File(out,"cloth.moc3").writeBytes(Moc3.write(edited));File(out,"cloth-spec.json").writeText(spec.toString())
        println("Wrote elbow-only cloth corrections; original rotation keys, parameter definitions and motion resources retained")
        return
    }
    if(args.getOrNull(2)=="inspect-bend") {
        val spec=Json.parseToJsonElement(File(args[3]).readText()).jsonObject
        val ids=spec["meshes"]!!.jsonArray.map{it.jsonPrimitive.content}.toSet()
        val ancestors=mutableSetOf<Int>()
        for(m in document.artMeshes.filter{it.id in ids}) {
            var index=m.parentDeformerIndex
            while(index>=0 && ancestors.add(index)) index=document.deformers[index].parentDeformerIndex
        }
        fun binding(index:Int)=JsonArray(document.keyformBinding(index)!!.axes.map{a->buildJsonObject{
            put("parameter",document.parameters[a.parameterIndex].id);put("keys",JsonArray(a.keyPositions.map{JsonPrimitive(it)}))
        }})
        fun floats(a:FloatArray)=JsonArray(a.map{JsonPrimitive(it)})
        File(out,"bend-geometry.json").writeText(buildJsonObject{
            put("meshes",JsonArray(document.artMeshes.filter{it.id in ids}.map{m->buildJsonObject{
                put("id",m.id);put("parent",document.deformers[m.parentDeformerIndex].id);put("binding",binding(m.keyformBindingIndex))
                put("uv",floats(m.vertexUvs));put("keys",JsonArray(m.keyforms.map{k->buildJsonObject{put("positions",floats(k.vertexPositions));put("opacity",k.opacity);put("order",k.drawOrder)}}))
            }}))
            put("deformers",JsonArray(ancestors.sorted().map{index->val d=document.deformers[index];buildJsonObject{
                put("id",d.id);put("parent",document.deformers.getOrNull(d.parentDeformerIndex)?.id);put("binding",binding(d.keyformBindingIndex))
                when(d){is WarpDeformer->{put("rows",d.rows);put("columns",d.columns);put("keys",JsonArray(d.keyforms.map{k->buildJsonObject{put("points",floats(k.controlPoints));put("opacity",k.opacity)}}))}
                    is RotationDeformer->{put("baseAngle",d.baseAngle);put("keys",JsonArray(d.keyforms.map{k->buildJsonObject{put("x",k.originX);put("y",k.originY);put("angle",k.angle);put("scale",k.scale);put("opacity",k.opacity)}}))}}
            }}))
            put("glues",JsonArray(document.glues.filter{document.artMeshes[it.meshAIndex].id in ids || document.artMeshes[it.meshBIndex].id in ids}.map{g->buildJsonObject{
                put("id",g.id);put("a",document.artMeshes[g.meshAIndex].id);put("b",document.artMeshes[g.meshBIndex].id);put("binding",binding(g.keyformBindingIndex));put("intensity",floats(g.intensityKeyforms))
                put("pairs",JsonArray(g.pairs.map{p->buildJsonObject{put("a",p.vertexA);put("b",p.vertexB);put("wa",p.weightA);put("wb",p.weightB)}}))
            }}))
        }.toString())
        println("Wrote targeted sleeve geometry and glue inspection")
        return
    }
    if(args.getOrNull(2)=="restore-reference-arms") {
        val spec=Json.parseToJsonElement(File(args[3]).readText()).jsonObject
        val referenceEntry=File(spec["reference"]!!.jsonPrimitive.content)
        val referenceRefs=Json.parseToJsonElement(referenceEntry.readText()).jsonObject["FileReferences"]!!.jsonObject
        val reference=Moc3.read(File(referenceEntry.parentFile,referenceRefs["Moc"]!!.jsonPrimitive.content).readBytes())
        require(reference.parameters.map{it.id}==document.parameters.map{it.id})
        require(reference.deformers.map{it.id}.toSet()==document.deformers.map{it.id}.toSet())
        val bindings=document.bindings.associateBy{it.index}.toMutableMap()
        fun copiedBinding(index:Int):Int {
            val next=(bindings.keys.maxOrNull()?:-1)+1
            bindings[next]=requireNotNull(reference.keyformBinding(index)).copy(index=next)
            return next
        }
        val rotationIds=spec["rotations"]!!.jsonArray.map{it.jsonPrimitive.content}.toSet()
        val deformers=document.deformers.map { d ->
            if(d.id !in rotationIds)d else {
                val original=reference.deformers.single{it.id==d.id} as RotationDeformer
                require(reference.deformers[original.parentDeformerIndex].id==document.deformers[d.parentDeformerIndex].id)
                original.copy(parentDeformerIndex=d.parentDeformerIndex,keyformBindingIndex=copiedBinding(original.keyformBindingIndex))
            }
        }
        val sleeveIds=spec["sleeves"]!!.jsonArray.map{it.jsonPrimitive.content}.toSet()
        val meshes=document.artMeshes.map { m ->
            if(m.id !in sleeveIds)m else {
                val original=reference.artMeshes.single{it.id==m.id}
                require(reference.deformers[original.parentDeformerIndex].id==document.deformers[m.parentDeformerIndex].id)
                val referenceIndex=reference.artMeshes.indexOf(original);val candidateIndex=document.artMeshes.indexOf(m)
                require(reference.glues.none{it.meshAIndex==referenceIndex || it.meshBIndex==referenceIndex})
                require(document.glues.none{it.meshAIndex==candidateIndex || it.meshBIndex==candidateIndex})
                val u=original.vertexUvs.filterIndexed{i,_->i%2==0};val v=original.vertexUvs.filterIndexed{i,_->i%2==1}
                val u0=u.min();val v0=v.min();val du=u.max()-u0;val dv=v.max()-v0
                val targetU=m.vertexUvs.filterIndexed{i,_->i%2==0};val targetV=m.vertexUvs.filterIndexed{i,_->i%2==1}
                val targetU0=targetU.min();val targetV0=targetV.min();val targetDU=targetU.max()-targetU0;val targetDV=targetV.max()-targetV0
                original.copy(parentPartIndex=m.parentPartIndex,parentDeformerIndex=m.parentDeformerIndex,
                    textureIndex=m.textureIndex,constantFlags=m.constantFlags,extendedBlend=m.extendedBlend,
                    maskDrawableIndices=m.maskDrawableIndices,keyformBindingIndex=copiedBinding(original.keyformBindingIndex),
                    vertexUvs=FloatArray(original.vertexUvs.size){i->if(i%2==0)targetU0+(original.vertexUvs[i]-u0)/du*targetDU else targetV0+(original.vertexUvs[i]-v0)/dv*targetDV},
                    keyforms=original.keyforms.mapIndexed{i,k->k.copy(drawOrder=m.keyforms.getOrElse(i){m.keyforms.first()}.drawOrder)})
            }
        }
        val edited=MocDocument(document.version,document.canvas,document.parameters,bindings,document.parts,deformers,meshes,document.glues,document.renderOrderGroups,document.blendShapes,document.offscreens,document.keyPositionsHasParameterUnion)
        File(out,"restored.moc3").writeBytes(Moc3.write(edited))
        File(out,"restore-spec.json").writeText(spec.toString())
        File(out,"restore-report.json").writeText(buildJsonObject {
            put("restoredRotations",JsonArray(rotationIds.map{JsonPrimitive(it)}));put("restoredSleeveGeometry",JsonArray(sleeveIds.map{JsonPrimitive(it)}))
            put("referenceMotionFilesModified",false);put("visualAccepted",false)
        }.toString())
        println("Restored ${rotationIds.size} original joint mappings and ${sleeveIds.size} original sleeve meshes; retained candidate textures")
        return
    }
    if(args.getOrNull(2)=="restore-reference-materials") {
        val spec=Json.parseToJsonElement(File(args[3]).readText()).jsonObject
        val referenceEntry=File(spec["reference"]!!.jsonPrimitive.content)
        val referenceRefs=Json.parseToJsonElement(referenceEntry.readText()).jsonObject["FileReferences"]!!.jsonObject
        val reference=Moc3.read(File(referenceEntry.parentFile,referenceRefs["Moc"]!!.jsonPrimitive.content).readBytes())
        val ids=spec["meshes"]!!.jsonArray.map{it.jsonPrimitive.content}.toSet()
        val offset=spec["textureOffset"]!!.jsonPrimitive.int
        val blank=spec["blank"]?.jsonArray.orEmpty().map{it.jsonPrimitive.content}.toSet()
        val changed=document.artMeshes.map { m ->
            if(m.id in blank)m.copy(textureIndex=spec["blankTextureIndex"]!!.jsonPrimitive.int)
            else if(m.id !in ids)m else {
                val source=reference.artMeshes.single{it.id==m.id}
                require(m.vertexUvs.size==source.vertexUvs.size && m.triangleIndices.contentEquals(source.triangleIndices)) { "Restore geometry before materials: ${m.id}" }
                val masks=source.maskDrawableIndices.map { index ->
                    document.artMeshes.indexOfFirst{it.id==reference.artMeshes[index].id}.also{require(it>=0)}
                }.toIntArray()
                m.copy(textureIndex=source.textureIndex+offset,vertexUvs=source.vertexUvs,
                    constantFlags=source.constantFlags,extendedBlend=source.extendedBlend,maskDrawableIndices=masks)
            }
        }
        require(changed.count{it.id in ids}==ids.size)
        val edited=MocDocument(document.version,document.canvas,document.parameters,document.bindings.associateBy{it.index},document.parts,document.deformers,changed,document.glues,document.renderOrderGroups,document.blendShapes,document.offscreens,document.keyPositionsHasParameterUnion)
        File(out,"materials-restored.moc3").writeBytes(Moc3.write(edited))
        File(out,"material-restore-spec.json").writeText(spec.toString())
        println("Restored original UVs, blend flags and masks for ${ids.size} meshes; geometry and motion unchanged")
        return
    }
    if(args.getOrNull(2)=="restore-cuff-order") {
        // ArtMesh343 was artificially lifted over its own cuff by a previous
        // occlusion workaround. Its original position in the order group is
        // still intact; restore only the order value, not its sculpted grid.
        val target = document.artMeshes.single { it.id == "ArtMesh343" }
        val anchor = document.artMeshes.single { it.id == "ArtMesh291" }
        require(anchor.keyforms.all { it.drawOrder == 500f })
        require(target.keyforms.all { it.drawOrder == 501f })
        val meshes = document.artMeshes.map { m ->
            if (m.id == target.id) m.copy(keyforms = m.keyforms.map { it.copy(drawOrder = 500f) }) else m
        }
        val edited = MocDocument(document.version, document.canvas, document.parameters, document.bindings.associateBy { it.index },
            document.parts, document.deformers, meshes, document.glues, document.renderOrderGroups,
            document.blendShapes, document.offscreens, document.keyPositionsHasParameterUnion)
        File(out, "cuff-order-restored.moc3").writeBytes(Moc3.write(edited))
        println("Restored ArtMesh343 draw order 501 -> 500 below its original cuff; geometry and motion unchanged")
        return
    }
    if(args.getOrNull(2)=="occlusion") {
        val spec=Json.parseToJsonElement(File(args[3]).readText()).jsonObject
        val edits=spec["meshes"]!!.jsonArray.associateBy{it.jsonObject["id"]!!.jsonPrimitive.content}
        val meshes=document.artMeshes.map { m ->
            val edit=edits[m.id]?.jsonObject ?: return@map m
            require(m.maskDrawableIndices.isEmpty() || m.constantFlags and 8 != 0) { "Cannot combine normal and inverted masks: ${m.id}, flags=${m.constantFlags}" }
            val masks=(m.maskDrawableIndices.toList()+edit["occludedBy"]!!.jsonArray.map { id -> document.artMeshes.indexOfFirst{it.id==id.jsonPrimitive.content}.also{require(it>=0)} }).distinct().toIntArray()
            m.copy(constantFlags=m.constantFlags or 8,maskDrawableIndices=masks)
        }
        require(edits.keys.all{id->document.artMeshes.any{it.id==id}})
        val edited=MocDocument(document.version,document.canvas,document.parameters,document.bindings.associateBy{it.index},document.parts,document.deformers,meshes,document.glues,document.renderOrderGroups,document.blendShapes,document.offscreens,document.keyPositionsHasParameterUnion)
        File(out,"occlusion.moc3").writeBytes(Moc3.write(edited));File(out,"occlusion-spec.json").writeText(spec.toString());println("Adjusted physical overlap only; geometry and motion unchanged");return
    }
    if(args.getOrNull(2)=="retarget") {
        val spec=Json.parseToJsonElement(File(args[3]).readText()).jsonObject
        val bindings=document.bindings.associateBy{it.index}.toMutableMap()
        val additionalIds=spec["addRotationParameters"]?.jsonArray.orEmpty().map{it.jsonPrimitive.content}
        require(additionalIds.distinct().size==additionalIds.size && additionalIds.none{id->document.parameters.any{it.id==id}})
        val template=document.parameters.single{it.id=="ParamBodyAngleZ"}
        val parameters=document.parameters+additionalIds.map{
            template.copy(id=it,minimumValue=-1f,maximumValue=1f,defaultValue=0f,repeats=false)
        }
        val changes=spec["rotations"]!!.jsonArray
        var deformers=document.deformers
        for(row in changes) { val edit=row.jsonObject
        deformers=deformers.map { d ->
            if(d.id!=edit["id"]!!.jsonPrimitive.content)return@map d
            require(d is RotationDeformer)
            val axisId=edit["parameter"]!!.jsonPrimitive.content
            val pi=parameters.indexOfFirst{it.id==axisId};require(pi>=0)
            val curve=edit["offsets"]!!.jsonArray.map{it.jsonArray.map{v->v.jsonPrimitive.float}}
            fun offset(v:Float):Float { val j=curve.indexOfLast{it[0]<=v}.coerceAtLeast(0);if(j==curve.lastIndex)return curve[j][1];val a=curve[j];val b=curve[j+1];return a[1]+(b[1]-a[1])*((v-a[0])/(b[0]-a[0])).coerceIn(0f,1f) }
            val old=bindings.getValue(d.keyformBindingIndex)
            val oldAxis=old.axes.indexOfFirst{it.parameterIndex==pi}
            val positions=((if(oldAxis>=0)old.axes[oldAxis].keyPositions.toList() else emptyList())+curve.map{it[0]}).distinct().sorted().toFloatArray()
            val axes=if(oldAxis>=0)old.axes.mapIndexed{i,a->if(i==oldAxis)KeyformAxis(pi,positions)else a} else old.axes+KeyformAxis(pi,positions)
            val binding=KeyformBinding((bindings.keys.maxOrNull()?:-1)+1,axes);bindings[binding.index]=binding
            val keys=(0 until axes.fold(1){n,a->n*a.keyCount}).map { index ->
                var stride=1;val values=axes.associate{a->val v=a.keyPositions[(index/stride)%a.keyCount];stride*=a.keyCount;a.parameterIndex to v}
                var samples=listOf(0 to 1f);var oldStride=1
                for(a in old.axes){val v=values.getValue(a.parameterIndex);val lo=a.keyPositions.indexOfLast{it<=v}.coerceAtLeast(0);val hi=(lo+1).coerceAtMost(a.keyCount-1);val t=if(hi==lo)0f else ((v-a.keyPositions[lo])/(a.keyPositions[hi]-a.keyPositions[lo])).coerceIn(0f,1f)
                    samples=samples.flatMap{(ix,w)->listOf(ix+lo*oldStride to w*(1-t),ix+hi*oldStride to w*t)};oldStride*=a.keyCount}
                fun blend(f:(org.umamo.format.moc3.model.RotationKeyform)->Float)=samples.sumOf{(i,w)->(f(d.keyforms[i])*w).toDouble()}.toFloat()
                d.keyforms[samples.maxBy{it.second}.first].copy(originX=blend{it.originX},originY=blend{it.originY},angle=blend{it.angle}+offset(values.getValue(pi)),scale=blend{it.scale},opacity=blend{it.opacity})
            }
            d.copy(keyformBindingIndex=binding.index,keyforms=keys)
        }
        }
        val neutral=CpuDeformationEvaluator().evaluate(puppet,emptyMap())
        val sleeves=spec["sleeves"]!!.jsonArray.associateBy{it.jsonObject["id"]!!.jsonPrimitive.content}
        val foreground=spec["foregroundMeshes"]?.jsonArray.orEmpty().map{it.jsonPrimitive.content}.toSet()
        val meshes=document.artMeshes.map { m ->
            val e=sleeves[m.id]?.jsonObject ?: return@map m
            require(m.keyforms.size==1)
            val world=neutral.worldPositions.getValue(DrawableId(m.id));val rest=FloatArray(world.size){if(it%2==0)world[it] else -world[it]}
            val y0=e["top"]!!.jsonPrimitive.float;val scale=e["scaleY"]!!.jsonPrimitive.float
            val points=FloatArray(rest.size){if(it%2==0)rest[it] else y0+(rest[it]-y0)*scale}
            m.copy(keyforms=listOf(m.keyforms.single().copy(vertexPositions=solveParent(puppet,m.id,rest,m.keyforms.single().vertexPositions,points))))
        }.map { m -> if(m.id in foreground)m.copy(keyforms=m.keyforms.map{it.copy(drawOrder=it.drawOrder+1f)})else m }
        val edited=MocDocument(document.version,document.canvas,parameters,bindings,document.parts,deformers,meshes,document.glues,document.renderOrderGroups,document.blendShapes,document.offscreens,document.keyPositionsHasParameterUnion)
        File(out,"retargeted.moc3").writeBytes(Moc3.write(edited));File(out,"retarget-spec.json").writeText(spec.toString());println("Retargeted ${changes.size} joint mappings and ${sleeves.size} sleeve meshes; motion files unchanged");return
    }
    if(args.getOrNull(2)=="atlas"){
        val spec=Json.parseToJsonElement(File(args[3]).readText()).jsonObject
        val maps=spec["meshes"]!!.jsonArray.associate{row->val m=row.jsonObject;m["id"]!!.jsonPrimitive.content to m}
        val changed=document.artMeshes.map{m->val map=maps.getValue(m.id)
            val uv=map["uv"]!!.jsonArray.map{it.jsonPrimitive.float}.toFloatArray();require(uv.size==m.vertexUvs.size)
            m.copy(textureIndex=map["textureIndex"]!!.jsonPrimitive.int,vertexUvs=uv)}
        val edited=MocDocument(document.version,document.canvas,document.parameters,document.bindings.associateBy{it.index},document.parts,document.deformers,changed,document.glues,document.renderOrderGroups,document.blendShapes,document.offscreens,document.keyPositionsHasParameterUnion)
        File(out,"atlas.moc3").writeBytes(Moc3.write(edited));println("Remapped UVs only: ${changed.size} meshes");return
    }
    if (args.getOrNull(2) == "adapt") {
        val spec = Json.parseToJsonElement(File(args[3]).readText()).jsonObject
        val replacements = spec["layers"]!!.jsonArray.associateBy { it.jsonObject["target"]!!.jsonPrimitive.content }
        val blanked = spec["blank"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
        val blankPage = spec["blankTextureIndex"]!!.jsonPrimitive.int
        val neutral = CpuDeformationEvaluator().evaluate(puppet, emptyMap())
        val changed = document.artMeshes.mapIndexed { index, mesh ->
            val layer = replacements[mesh.id]?.jsonObject
            if (layer == null) { if(mesh.id in blanked)mesh.copy(textureIndex=blankPage) else mesh }
            else {
                if(layer["preserveMesh"]?.jsonPrimitive?.boolean == true) {
                    val coords=if(layer["uvFromCanvas"]?.jsonPrimitive?.boolean == true)neutral.worldPositions.getValue(DrawableId(mesh.id)).mapIndexed{i,v->if(i%2==0)v else -v}.toFloatArray() else mesh.vertexUvs
                    val us=coords.filterIndexed{i,_->i%2==0};val vs=coords.filterIndexed{i,_->i%2==1}
                    val u0=us.min();val v0=vs.min();val du=us.max()-u0;val dv=vs.max()-v0
                    return@mapIndexed mesh.copy(textureIndex=layer["textureIndex"]!!.jsonPrimitive.int, constantFlags=4,extendedBlend=0,
                        maskDrawableIndices=if(layer["clearMasks"]?.jsonPrimitive?.boolean == true)intArrayOf() else mesh.maskDrawableIndices,
                        vertexUvs=FloatArray(coords.size){i->if(i%2==0)(coords[i]-u0)/du else (coords[i]-v0)/dv})
                }
                val source = document.artMeshes.single { it.id == (layer["bindingSource"]?.jsonPrimitive?.content ?: mesh.id) }
                require(source.keyforms.size==1 && document.keyformBinding(source.keyformBindingIndex)!!.axes.isEmpty()) { "Requires static mesh geometry: ${source.id}" }
                require(mesh.keyforms.size==1 && document.keyformBinding(mesh.keyformBindingIndex)!!.axes.isEmpty()) { "Target has authored mesh keys: ${mesh.id}" }
                require(document.glues.none { it.meshAIndex==index || it.meshBIndex==index }) { "Cannot replace welded mesh ${mesh.id}" }
                val rect = layer["rect"]!!.jsonArray.map { it.jsonPrimitive.float }
                val n=16; val canvas=FloatArray((n+1)*(n+1)*2); val uv=FloatArray(canvas.size); val ix=ArrayList<Short>()
                for(y in 0..n)for(x in 0..n) {
                    val k=(y*(n+1)+x)*2
                    canvas[k]=rect[0]+rect[2]*x/n; canvas[k+1]=rect[1]+rect[3]*y/n
                    uv[k]=x.toFloat()/n; uv[k+1]=y.toFloat()/n
                    if(x<n&&y<n){val a=y*(n+1)+x;listOf(a,a+1,a+n+2,a,a+n+2,a+n+1).forEach{ix.add(it.toShort())}}
                }
                val bindPose=layer["bindPose"]?.jsonObject?.map { (k,v)->ParameterId(k) to v.jsonPrimitive.float }?.toMap().orEmpty()
                val evaluated=if(bindPose.isEmpty())neutral else CpuDeformationEvaluator().evaluate(puppet,bindPose)
                val world=evaluated.worldPositions.getValue(DrawableId(source.id))
                val rest=FloatArray(world.size){if(it%2==0)world[it] else -world[it]}
                val local=solveParent(puppet,source.id,rest,source.keyforms.single().vertexPositions,canvas,bindPose)
                // New complete painted layers use normal premultiplied blending;
                // original shadow slots may instead use multiply or inverted masks.
                val opacitySource=layer["opacityDeformer"]?.jsonPrimitive?.content?.let{id->document.deformers.single{it.id==id} as WarpDeformer}
                val behind=layer["occludedBy"]?.jsonArray?.map{item->document.artMeshes.indexOfFirst{it.id==item.jsonPrimitive.content}.also{require(it>=0)}}.orEmpty()
                mesh.copy(textureIndex=layer["textureIndex"]!!.jsonPrimitive.int, constantFlags=if(behind.isEmpty())4 else 12, extendedBlend=0,
                    vertexUvs=uv, triangleIndices=ix.toShortArray(),
                    maskDrawableIndices=behind.toIntArray(),
                    parentDeformerIndex=source.parentDeformerIndex, keyformBindingIndex=opacitySource?.keyformBindingIndex ?: source.keyformBindingIndex,
                    keyforms=opacitySource?.keyforms?.map{mesh.keyforms.single().copy(vertexPositions=local,opacity=mesh.keyforms.single().opacity*it.opacity)} ?: mesh.keyforms.map{it.copy(vertexPositions=local)})
            }
        }
        val transforms=spec["warpTransforms"]?.jsonArray.orEmpty().associateBy{it.jsonObject["id"]!!.jsonPrimitive.content}
        val deformers=document.deformers.map { d ->
            val transform=transforms[d.id]?.jsonObject
            if(transform==null)d else {
                require(d is WarpDeformer)
                val base=d.keyforms.first().controlPoints
                val cx=base.filterIndexed{i,_->i%2==0}.average().toFloat();val cy=base.filterIndexed{i,_->i%2==1}.average().toFloat()
                val sx=transform["scaleX"]!!.jsonPrimitive.float;val sy=transform["scaleY"]!!.jsonPrimitive.float
                d.copy(keyforms=d.keyforms.map{k->k.copy(controlPoints=FloatArray(k.controlPoints.size){i->val center=if(i%2==0)cx else cy;center+(k.controlPoints[i]-center)*(if(i%2==0)sx else sy)})})
            }
        }
        val edited=MocDocument(document.version,document.canvas,document.parameters,document.bindings.associateBy{it.index},document.parts,deformers,changed,document.glues,document.renderOrderGroups,document.blendShapes,document.offscreens,document.keyPositionsHasParameterUnion)
        File(out,"adapted.moc3").writeBytes(Moc3.write(edited))
        File(out,"adaptation.json").writeText(buildJsonObject{put("spec",spec);put("sourceModel",manifest.absolutePath);put("preservedParameters",document.parameters.size);put("preservedDeformers",document.deformers.size);put("completeCharacter",false)}.toString())
        println("Adapted ${replacements.size} production layers; retained all other records")
        return
    }
    if (args.getOrNull(2) == "inspect") {
        File(out,"deformer-inspection.json").writeText(JsonArray(document.deformers.map { d -> buildJsonObject {
            put("id",d.id);put("parent",d.parentDeformerIndex);put("binding",document.keyformBinding(d.keyformBindingIndex).toString())
            if(d is RotationDeformer){put("baseAngle",d.baseAngle);put("keys",JsonArray(d.keyforms.map{k->buildJsonObject{put("x",k.originX);put("y",k.originY);put("angle",k.angle);put("scale",k.scale);put("opacity",k.opacity)}}))}
        }}).toString())
        for (id in args.getOrNull(3)?.split(",") ?: listOf("ArtMesh132", "ArtMesh133", "ArtMesh2", "ArtMesh27", "ArtMesh187")) {
            val mesh = document.artMeshes.single { it.id == id }
            println("$id part=${mesh.parentPartIndex} deformer=${mesh.parentDeformerIndex} keyforms=${mesh.keyforms.size} order=${mesh.keyforms.first().drawOrder} binding=${document.keyformBinding(mesh.keyformBindingIndex)}")
            var parent = puppet.drawables.single { it.id.raw == id }.parentDeformerId
            while (parent != null) {
                val d = puppet.deformers.single { it.id == parent }
                val axes = when (d) { is Deformer.Warp -> d.geometryGrid?.axes; is Deformer.Rotation -> d.geometryGrid?.axes }
                println("  ${d.id.raw} ${d.name} ${d::class.simpleName} axes=${axes?.map { it.parameterId.raw }}")
                if (axes?.any { it.parameterId.raw == "key10" } == true) {
                    val raw=document.deformers.single { it.id == d.id.raw } as WarpDeformer
                    println("  opacity binding=${document.keyformBinding(raw.keyformBindingIndex)} values=${raw.keyforms.map{it.opacity}}")
                }
                parent = d.parent
            }
        }
        document.parts.forEachIndexed { i,p -> if (p.id in listOf("Part161", "Part2")) println("part $i $p") }
        return
    }
    if (args.getOrNull(2) == "hat") {
        val target = document.artMeshes.single { it.id == "ArtMesh132" }
        require(target.keyforms.size == 1 && document.keyformBinding(target.keyformBindingIndex)!!.axes.isEmpty())
        val index = document.artMeshes.indexOf(target)
        require(document.glues.none { it.meshAIndex == index || it.meshBIndex == index })
        val n = 12
        val canvas = FloatArray((n+1)*(n+1)*2)
        val uv = FloatArray(canvas.size)
        val ix = ArrayList<Short>()
        for (y in 0..n) for (x in 0..n) {
            val k = (y*(n+1)+x)*2
            canvas[k] = 1700f + 850f*x/n; canvas[k+1] = 440f + 850f*y/n
            uv[k] = x.toFloat()/n; uv[k+1] = y.toFloat()/n
            if (x<n && y<n) { val a = y*(n+1)+x; listOf(a,a+1,a+n+2,a,a+n+2,a+n+1).forEach { ix.add(it.toShort()) } }
        }
        val restWorld = CpuDeformationEvaluator().evaluate(puppet, emptyMap()).worldPositions.getValue(DrawableId(target.id))
        val restCanvas = FloatArray(restWorld.size) { if(it%2==0)restWorld[it] else -restWorld[it] }
        val local = solveParent(puppet,target.id,restCanvas,target.keyforms.single().vertexPositions,canvas)
        println("canvas=${document.canvas} sourceCanvasX=${restCanvas.filterIndexed{i,_->i%2==0}.let{listOf(it.min(),it.max())}} sourceCanvasY=${restCanvas.filterIndexed{i,_->i%2==1}.let{listOf(it.min(),it.max())}} localNew=${local.toList().let{listOf(it.min(),it.max())}}")
        val changed = document.artMeshes.map { mesh -> when (mesh.id) {
            "ArtMesh2" -> mesh.copy(textureIndex=5, vertexUvs=uv, triangleIndices=ix.toShortArray(),
                parentDeformerIndex=target.parentDeformerIndex, keyformBindingIndex=target.keyformBindingIndex,
                maskDrawableIndices=intArrayOf(),
                keyforms=target.keyforms.map { it.copy(vertexPositions=local) })
            "ArtMesh132", "ArtMesh133" -> mesh.copy(textureIndex=6)
            else -> mesh
        } }
        val edited = MocDocument(document.version, document.canvas, document.parameters,
            document.bindings.associateBy { it.index }, document.parts, document.deformers, changed,
            document.glues, document.renderOrderGroups, document.blendShapes, document.offscreens, document.keyPositionsHasParameterUnion)
        File(out, "hat-adapted.moc3").writeBytes(Moc3.write(edited))
        File(out, "hat-adaptation.json").writeText(buildJsonObject {
            put("replacedMesh", "ArtMesh2"); put("blankedMeshes", "ArtMesh132,ArtMesh133"); put("parentDeformer", puppet.drawables.single { it.id.raw==target.id }.parentDeformerId?.raw)
            put("gridVertices", canvas.size/2); put("gridTriangles", ix.size/3)
            put("allOtherMocRecordsPreserved", true); put("artwork", args[3]); put("completeCharacter", false)
        }.toString())
        println("Hat mesh replaced with inherited reference deformer; all other records retained")
        return
    }
    val owners = puppet.partByDrawable()
    File(out, "drawable-owners.json").writeText(JsonArray(puppet.drawables.map { d -> buildJsonObject {
        put("id", d.id.raw); put("part", owners[d.id]?.raw)
        put("partName", puppet.parts.find { it.id == owners[d.id] }?.name)
        put("parentDeformer", d.parentDeformerId?.raw)
        put("axes", JsonArray(d.geometryGrid?.axes.orEmpty().map { JsonPrimitive(it.parameterId.raw) }))
    }}).toString())
    val rebased = restMeshesToCanvasSpace(puppet)
    val rawLower = Moc3Export.toMocDocument(puppet)
    File(out, "raw-import-roundtrip.moc3").writeBytes(Moc3.write(rawLower.document))
    val lower = Moc3Export.toMocDocument(rebased)
    File(out, "import-roundtrip.moc3").writeBytes(Moc3.write(lower.document))
    File(out, "import-report.json").writeText(buildJsonObject {
        put("imported", counts(puppet)); put("rebased", counts(rebased))
        put("exportNotices", JsonArray(lower.report.notices.map { JsonPrimitive(it.toString()) }))
    }.toString())
    println("wrote imported rig MOC")
    if (args.getOrNull(2) != "cmo3") return
    val pages = refs["Textures"]!!.jsonArray.map {
        val bytes = File(manifest.parentFile, it.jsonPrimitive.content).readBytes()
        val img = ImageIO.read(bytes.inputStream())
        Cmo3Conversion.AtlasPage(bytes, img.width, img.height)
    }
    println("converting editable CMO3")
    val projectName = args.getOrNull(4) ?: "Reference binding recovery - local experiment"
    // The reference stores repeat flags in its V50 MOC. The CMO authoring gate
    // requires 5.3 to retain them; runtime export still explicitly targets V50.
    val editablePuppet = rebased.copy(runtimeTarget = RuntimeTarget.Cubism53)
    val converted = Cmo3Conversion.freshCmo3(editablePuppet, pages, rebased.drawables.associate { it.id.raw to it.texturePage },
        projectName, System.currentTimeMillis(), 12345)
    val preservedKeyforms = preserveParentKeyforms(converted.model.root as CModelSource, puppet)
    val bytes = Cmo3.write(converted.model)
    File(out, "reference-recovered.cmo3").writeBytes(bytes)
    val readback = exportPuppet(Cmo3.read(bytes).root as CModelSource)
    val roundtrip = Moc3Export.toMocDocument(readback)
    File(out, "cmo3-roundtrip.moc3").writeBytes(Moc3.write(roundtrip.document))
    val poses = Json.parseToJsonElement(File(args[3]).readText()).jsonArray
    val evaluator = CpuDeformationEvaluator()
    val comparisons = poses.map { row ->
        val pose = row.jsonArray[1].jsonObject.mapKeys { ParameterId(it.key) }.mapValues { it.value.jsonPrimitive.float }
        val before = evaluator.evaluate(puppet, pose)
        val after = evaluator.evaluate(readback, pose)
        var maxError = 0f; var missing = 0
        for ((id, positions) in before.worldPositions) {
            val other = after.worldPositions[id]
            if (other == null || positions.size != other.size) { missing++; continue }
            for (i in positions.indices) maxError = maxOf(maxError, kotlin.math.abs(positions[i] - other[i]))
        }
        buildJsonObject { put("name", row.jsonArray[0]); put("maxCanvasPixelError", maxError); put("missingMeshes", missing) }
    }
    File(out, "cmo3-report.json").writeText(buildJsonObject {
        put("bytes", bytes.size); put("encoded", counts(converted.puppet)); put("readback", counts(readback))
        put("notices", JsonArray(converted.report.notices.map { JsonPrimitive(it.toString()) }))
        put("roundtripNotices", JsonArray(roundtrip.report.notices.map { JsonPrimitive(it.toString()) }))
        put("cpuReadbackComparison", JsonArray(comparisons))
        put("isOriginalSource", false); put("projectName", projectName)
        put("preservedParentKeyforms", preservedKeyforms)
        put("coordinatePolicy", "Editable canvas rest retained; parent keyform absolutes restored at resolved parameter-grid coordinates, including animated channel unions; zero-base runtime import avoids Float cancellation")
        put("sourceRuntime", manifest.absolutePath)
        put("sourceArtProvenance", "Reconstructed from the actual runtime mesh textures; authored source PNGs are retained separately")
    }.toString())
    println("CMO3 written and reopened: ${counts(readback)}")
}
