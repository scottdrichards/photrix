import { useEffect, useState } from "react";
import { getFolderContents, MediaDirectoryResult } from "./data/api";

export type Node = {
    name:string;
    type: 'directory'|'file';
    expanded:boolean;
    children?:Node[];
}    

const mediaResultToNode = (result:MediaDirectoryResult[number]):Node=>({
    name: result.path.split('/').at(-1),
    type: result.type,
    expanded: false,
    children: undefined
})

export type Selected = {
    fullPath:string;
    type:Node['type'];
}
type Params = {
    onSelect: (element: Selected)=>void;
    style?: React.CSSProperties;
}

export const FolderExplorer:React.FC<Params> = (params)=>{
    const {onSelect, style} = params;
    const [root, setRoot] = useState<Node>({name:"root", type:'directory',children:[], expanded:true});

    useEffect(()=>{
        (async ()=>{
            const results = await getFolderContents("");
            const newRoot:Node = {
                name:"root",
                type:'directory',
                expanded:true,
                children: results.map(mediaResultToNode)
            };
            setRoot(newRoot);
        })();
    },[]);

    const setFolderExpand = async (path:string[], expanded:boolean)=>{
        const toggle = async(node:Node, pathRemaining:string[], currentPath:string[]):Promise<Node>=>{
            if (!pathRemaining.length || node.name !== pathRemaining[0] || node.type !== 'directory') return node;

            const isExpanded = () => {
                if (pathRemaining.length === 1){
                    // If this is the target folder, set it based on the expanded parameter
                    return expanded;
                }
                if (expanded){
                    // If a child is expanded, set parent to expanded too
                    return true;
                }
                // Keep parent state
                return node.expanded;
            }

            const localExpanded = isExpanded();
            
            const children = localExpanded?
                (
                    node.children ?? 
                    await getFolderContents(currentPath.join('/')).then(results=>results.map(mediaResultToNode))
                )?.map(async child=>
                    await toggle(child, pathRemaining.slice(1), [...currentPath, child.name])
                ) : 
                node.children; // If this is not expanded, leave children as is

            // children.map returns promises, so we need to await them
            const childrenResoved = children && await Promise.all(children);
            // If the children are different from the original, sort them
            const childrenSorted = node.children === childrenResoved ? node.children : childrenResoved?.sort((a,b)=>{
                if (a.type === 'directory' && b.type === 'file') return -1;
                if (a.type === 'file' && b.type === 'directory') return 1;
                return a.name.localeCompare(b.name);
            });
            return {...node,
                children: childrenSorted,
                expanded: localExpanded,
            }};
        const rootCopy = await toggle(root, path, []);
        setRoot((prevRoot=>{
            if (prevRoot !== root){
                console.error('Toggle function is async and root has changed in the meantime. You may want to refactor the state vs data.');
            }
            return rootCopy;
        }));
    }


    const Render = (params:{element:Node, parentPath:string[]})=>{
        const {element:el, parentPath} = params
        const currentPath = [...parentPath, el.name];
        return <>
            <div style={{paddingLeft: '20px', display:'flex', flexDirection:'column', alignItems:'flex-start'}}>
                <div>
                    {el.type==='directory'&& <span
                        onClick={()=>setFolderExpand(currentPath, !el.expanded)}>
                            {el.expanded ? '📂':'📁'}
                        </span>
                    }
                    <span onClick={()=>onSelect({
                        fullPath:currentPath.slice(1).join('/'),
                        type: el.type
                    }
                    )}>{el.name}</span>
                </div>
                {el.expanded && el.children?.filter(c=>c.type === "directory").map(child=><Render key={child.name} element={child} parentPath={currentPath}/>)}
            </div>
        </>
    }
    return <div style={style}> <Render element={root} parentPath={[]}/></div>
}