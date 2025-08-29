import { createContext, ReactNode, useContext, useMemo, useState } from 'react';
import { mediaURLBase } from '../data/api';

export const RatingOptions = [
    "1",
    "2",
    "3",
    "4",
    "5"
] as const;

export type Filter = {
    date_taken?: {
        from: Date;
        to: Date;
    },
    rating?: typeof RatingOptions[number][];
    fileType?: 'image' | 'video';
    hierarchical_subject?: string;
    keywords?: string[];
    excludeSubfolders?: boolean;
    parentFolder?: string;
    gps_latitude?: {
        from: number;
        to: number;
    };
    gps_longitude?: {
        from: number;
        to: number;
    };
}

type FilterContextType = {
    filter: Filter;
    setFilter: (value: Filter) => void;
};

const FilterContext = createContext<FilterContextType | undefined>(undefined);

const cleanFilter = (filter: Filter): Filter => Object.fromEntries(
    Object.entries(filter)
        .filter(([_, value]) => {
            if (value === undefined) {
                return false;
            }
            if (Array.isArray(value) && value.length === 0) {
                return false;
            }
            return true;
        })) as Filter;


export const FilterProvider = ({ children }: { children: ReactNode }) => {
    const [filter, setFilterState] = useState<Filter>({
        excludeSubfolders: true
    });

    const setFilter = (value: Filter) => setFilterState(cleanFilter(value));

    return (
        <FilterContext.Provider value={{ filter, setFilter }}>
            {children}
        </FilterContext.Provider>
    );
};

export const useFilter = (): FilterContextType & { url: Readonly<URL> } => {
    const context = useContext(FilterContext);
    if (!context) {
        throw new Error('useFilter must be used within a FilterProvider');
    }

    const returnValue = useMemo(()=>{
        const url = new URL(context.filter.parentFolder ?? "", mediaURLBase);
        Object.entries(context.filter).forEach(([key, value]) => {
            if (value !== undefined && key !== 'parentFolder') {
                url.searchParams.set(key, JSON.stringify(value));
            }
        });
        return {...context, url}
    }, [context.filter])
    return returnValue;
};