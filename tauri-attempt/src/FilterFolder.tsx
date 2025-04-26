import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Params = {
    setSelectedFolder: (folder: string) => void
}
type Folder = {
    path: string;
    name: string;
    expanded: boolean;
}
const sortFolderList = (a:Folder, b:Folder) => {
    const aPaths = a.path.split('/');
    const bPaths = b.path.split('/');
    for (let i = 0; i < Math.min(aPaths.length, bPaths.length); i++) {
        const aPathSegment = aPaths[i];
        const bPathSegment = bPaths[i];
        if (aPathSegment !== bPathSegment) {
            return aPathSegment.localeCompare(bPathSegment);
        }
    }
    return aPaths.length - bPaths.length;
}

export const FilterFolder = (params: Params) => {
    const [folders, setFolders] = useState<Folder[]>([]);
    useEffect(() => {
        invoke<{name:string}[]>("fetch_directory_contents",{directory: ".", includeFiles:false})
        .then(r=>{
            setFolders(r.map(f=>({
                path:f.name,
                name:f.name,
                expanded:false
            })));
        });
    }, []);

    const onFolderCollapse = (folder: Folder) => {
        setFolders(
            folders.filter(f => !f.path.startsWith(folder.path))
            .concat({...folder, expanded: false})
            .sort(sortFolderList));
    }

    const onFolderExpand = async (folder: Folder) => {
        const results = await invoke<{name:string}[]>("fetch_directory_contents",{directory: folder.path, includeFiles:false})
            .then(r=>r.map(f=>(
                {
                    path: folder.path + "/" + f.name,
                    name: f.name,
                    expanded: false
                })));

        setFolders(folders
            .map(f => f.path === folder.path ? {...f, expanded: true} : f)
            .concat(results)
            .sort(sortFolderList)
        );
    }
    return (
        <div>
            <h2>Folder</h2>
            <ul style={{marginBlockStart: 0, paddingInlineStart: 0}}>
                {folders.map(f => (
                    <li key={f.path} style={{
                        marginLeft: f.path.split("/").length * 10,
                        listStyleType: 'none',
                        display: 'flex',
                        flexDirection: 'row',
                        }}>
                        <button
                            onClick={() => f.expanded ? onFolderCollapse(f) : onFolderExpand(f)}
                            style={{
                                appearance: 'none',
                                border: 'none',
                                background: 'none',
                                padding: 0,
                                margin: 0,
                                boxShadow: 'none',
                            }}
                            >
                            {f.expanded ? "📂" : "📁"}
                        </button>
                        <div onClick={() => params.setSelectedFolder(f.path)}
                            style={{
                                cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
                            }}
                            >{f.name}</div>
                    </li>
                ))}
            </ul>
        </div>
    )
}