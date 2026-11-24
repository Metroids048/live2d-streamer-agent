use std::{env,fs,path::Path};
fn main() {
    let source="../../evidence/single-image-live2d/05/leaf-source/src-tauri/src/vts.rs";
    println!("cargo:rerun-if-changed={source}");
    let all=fs::read_to_string(source).unwrap();
    // Compile the original config reader, without its unrelated native file dialog.
    let (reader,_) = all.split_once("#[tauri::command]").unwrap();
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("vts-config.rs"),
        reader.replace("use tauri_plugin_dialog::DialogExt;","")).unwrap();
}
