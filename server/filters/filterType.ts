import type { Folder, MediaFile } from "../database";

export type Filter<T> = Partial<{
    /**
     * A generator function that yields items matching the filter criteria. Decided to not use
     * iterable here so as to ensure that the items being yielded do not come from an in-memory
     * array/set/etc. so that the generator can be used to filter large datasets.
     */
    generator: Generator<T>;
    /**
     * A function that validates whether an item matches the filter criteria.
     * This is useful when the generator results might be significantly larger than
     * other filters. So validator can be used on an item by item basis.
     */
    validator: (item: T) => boolean;
    /**
     * Just a set of items that match the filter. Useful when the filter results are small
     */
    set: Set<T>;
}>;