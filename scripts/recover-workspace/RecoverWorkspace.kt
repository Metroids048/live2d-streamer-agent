package io.github.psd2live.application

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.nio.file.Files
import java.nio.file.Path

// Uses the pinned editor's own recovery reader and project writer. The caller
// supplies a detached copy of the checkpoint store, never the live workspace.
fun main(args: Array<String>) = runBlocking {
    require(args.size == 4) { "RecoverWorkspaceKt <copied-store> <project-id> <new-archive> <new-report>" }
    System.setProperty("java.awt.headless", "true")
    val root=Path.of(args[0]).toRealPath();val projectId=args[1]
    val output=Path.of(args[2]);val report=Path.of(args[3])
    require(!Files.exists(output) && !Files.exists(report)) { "Recovery outputs already exist" }
    val marker=Json.parseToJsonElement(Files.readString(root.resolve("session.json"))).jsonObject
    require(marker.getValue("projectId").jsonPrimitive.content==projectId) { "Foreign recovery marker" }
    val checkpoint=Json.parseToJsonElement(Files.readString(root.resolve(projectId).resolve("recovery.json"))).jsonObject
    val session=SessionRecovery.Session(root,projectId,marker["projectFile"]?.jsonPrimitive?.contentOrNull,
        marker.getValue("inputPath").jsonPrimitive.content,marker.getValue("name").jsonPrimitive.content)
    val presentation=HeadlessPresentation();val host=WorkspaceHost(presentation,root);presentation.attach(host)
    try {
        val restored=host.restoreSession(session)
        require(restored.historyNodeId==checkpoint.getValue("historyHead").jsonPrimitive.content) { "Recovery HEAD changed" }
        val saved=host.saveCapture(output)
        require(!saved.createdNode && saved.history.headNodeId==restored.historyNodeId) { "Saving appended an edit" }
        val result=buildJsonObject {
            put("projectId",saved.projectId);put("historyNodeId",restored.historyNodeId);put("revision",restored.revisionId)
            put("checkpointState",checkpoint.getValue("state"));put("restoredState",restored.state)
            put("createdNode",saved.createdNode);put("method","PSD2Live WorkspaceHost.restoreSession + saveCapture")
        }
        Files.writeString(report,Json { prettyPrint=true }.encodeToString(JsonElement.serializer(),result)+"\n")
        println(result)
    } finally {host.close();presentation.close()}
}
