import { createContext, ReactNode, useContext, useState } from 'react';

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
    hierarchical_subject?: string;
    excludeSubfolders?: boolean;
    parentFolder?: string;
}

type FilterContextType = {
    filter: Filter;
    setFilter: (value: Filter) => void;
};

const FilterContext = createContext<FilterContextType | undefined>(undefined);

export const FilterProvider = ({ children }: { children: ReactNode }) => {
    const [filter, setFilter] = useState<Filter>({
        excludeSubfolders: true
    });

    return (
        <FilterContext.Provider value={{ filter, setFilter }}>
            {children}
        </FilterContext.Provider>
    );
};

export const useFilter = (): FilterContextType => {
    const context = useContext(FilterContext);
    if (!context) {
        throw new Error('useFilter must be used within a FilterProvider');
    }
    return context;
};