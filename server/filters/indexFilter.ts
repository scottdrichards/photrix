import { type Folder, type MediaFile } from "../database"
import type { Indexes } from "../indexUtils";
import type { Filter } from "./filterType";



type Params<T> = Partial<{
    [key in keyof Indexes<T>]: (Indexes<T>)[key] extends Map<infer T, any> ? 
        T|T[] : 
        Indexes<T>[key] extends {getBetween:any}?
            Parameters<Indexes<T>[key]['getBetween']>extends [infer U]?U:never: // infer to extract from tuple
            never;
}>

export const indexFilters = <T>(indexes:Readonly<Indexes<T>>,params:Params<T>):Filter<T>[]=>{
    const filters = Object.entries(params)
        .filter(([,value])=>{
            if (value === undefined || value === null){
                return false;
            }
            if (Array.isArray(value) && value.length === 0){
                return false;
            }
            return true;
        })
        .map<Filter<T>>(([k,v])=>{
            const index = indexes[k as keyof Indexes<T>];
            if (index === undefined){
                throw new Error(`Index not found for key: ${k}`);
            }
            if ('getBetween' in index){
                type GetBetweenParams = Parameters<typeof index.getBetween>;
                return {
                    generator:index.getBetween(v as GetBetweenParams[0])
                }
            }
            const vArray = Array.isArray(v) ? v : [v] as string[];
            const set = vArray
                .flatMap(v=>[...index.entries()]
                        // Get all index entries if the key includes the value
                        .filter(([key, _]) => key.includes(v.toLocaleLowerCase()))
                        .map(([_, value]) => value)
                )
                .reduce((acc,cur)=>acc.union(cur)) // This might be an expensive operation if the sets are large
            return {
                set,
                validator: (item:T) => set.has(item),
            }
        });

    return filters;
}