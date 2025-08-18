import { useEffect, useState } from "react";
import { Filter, useFilter } from "../contexts/filterContext";
import { getColumnDistinctValues, type ColumnValueWithCount } from "../data/api";

export const useOptions = (column:keyof Filter, containsText?:string)=>{
    const [valuesWithCounts, setValuesWithCounts] = useState<ColumnValueWithCount[]|null>(null);
    const {filter} = useFilter();

    useEffect(()=>{
        getColumnDistinctValues({column, filter, containsText}).then(result => {
            setValuesWithCounts(result);
        });
    },[column, filter, containsText]);

    return valuesWithCounts;
};

// New hook that returns values with counts
export const useOptionsWithCounts = (column:keyof Filter, containsText?:string)=>{
    const [valuesWithCounts, setValuesWithCounts] = useState<ColumnValueWithCount[]|null>(null);
    const {filter} = useFilter();

    useEffect(()=>{
        getColumnDistinctValues({column, filter, containsText}).then(setValuesWithCounts);
    },[column, filter, containsText]);
    
    return valuesWithCounts;
};