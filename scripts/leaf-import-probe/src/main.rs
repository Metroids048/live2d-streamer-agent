use std::{env, path::PathBuf};

// The reviewed Leaf macOS v1.3.1 registry. The only UI dependency of this
// module is language selection for errors; choose English in this console.
mod locale { pub fn text(messages: [&str; 5]) -> &str { messages[0] } }
mod vts { include!(concat!(env!("OUT_DIR"), "/vts-config.rs")); }
#[allow(dead_code)]
mod models { include!("../../../evidence/single-image-live2d/05/leaf-source/src-tauri/src/models.rs"); }

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args_os().skip(1).map(PathBuf::from).collect();
    if args.len() != 2 || !args[0].is_file() || args[1].exists() {
        return Err("expected a ZIP and a new isolated library directory".into());
    }
    let registry = models::Registry::default();
    let info = registry.load(&args[0], &args[1])?;
    // Serve every entry through the real registry before passing its imported
    // library path to the isolated renderer.
    for name in &info.files { registry.read(&info.id, name)?; }
    println!("{}", serde_json::to_string(&info)?);
    Ok(())
}
