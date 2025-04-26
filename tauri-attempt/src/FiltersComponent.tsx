import { Filters } from "./data/filters";
import { FilterFolder } from "./FilterFolder"

type Params = {
    setFilters: (filters: Filters) => void,
    filters: Filters,
}
export const FiltersComponent = (params: Params) => {
    const {setFilters, filters} = params;
    return (
        <div>
            FiltersPanel
            <FilterFolder setSelectedFolder={(f)=>setFilters({...filters, folder:f})}/>
        </div>
    )
}