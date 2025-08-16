import { useEffect, useState } from "react";
import { Filter, useFilter } from "../contexts/filterContext";
import { getColumnDistinctValues } from "../data/api";

export const useOptions = (column:keyof Filter, containsText?:string)=>{
    const [values, setValues] = useState<string[]|null>(null);
    const {filter} = useFilter();

    useEffect(()=>{
        getColumnDistinctValues({column, filter, containsText}).then(setValues)
    },[column, filter, containsText]);
    return values;
};