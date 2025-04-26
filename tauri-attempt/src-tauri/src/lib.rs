#[derive(serde::Serialize)]
struct Entry {
    name: String,
    is_dir: bool,
}

#[tauri::command]
fn fetch_directory_contents(directory: Option<&str>, include_dirs: Option<bool>, include_files: Option<bool>) -> Result<Vec<Entry>, String> {
    let directory = directory.unwrap_or("");
    let full_directory_path = std::path::Path::new("//TRUENAS/Date-uh/Pictures and Videos").join(directory);

    let entries: Vec<Entry> = std::fs::read_dir(full_directory_path)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.unwrap();
            if (entry.path().is_dir() && include_dirs.unwrap_or(true))||
               (entry.path().is_file() && include_files.unwrap_or(true)){
                Some(Entry {
                        name: entry.file_name().to_str().unwrap().to_string(),
                        is_dir: entry.path().is_dir(),
                    })
            } else {
                None
            }
        })
        .collect();
    Ok(entries)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![fetch_directory_contents])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
