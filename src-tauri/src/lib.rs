

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Crust!", name)
}

#[tauri::command]
fn get_files() -> Vec<String> {
    let mut files = vec![];
    let mut dirs_stack = vec![std::path::PathBuf::from("//TRUENAS/Date-uh/Pictures and Videos")];

    while let Some(dir) = dirs_stack.pop() {
        println!("Processing path: {:?}", &dir);
        for entry in std::fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                dirs_stack.push(path);
            } else {
                let relative_path = path.strip_prefix("//TRUENAS/Date-uh/Pictures and Videos").unwrap().display().to_string();
                files.push(relative_path);
            }
        }
    }
    files
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, get_files])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
