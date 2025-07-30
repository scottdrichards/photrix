import { SortedListIndex } from "./utils/SortedListIndex";

export const makeIndexes = <T>()=>({
    dateTaken: new SortedListIndex<T>(),
    subject: new Map<string, Set<T>>(),
    Rating: new Map<string, Set<T>>(),
    Make: new Map<string, Set<T>>(),
    Model: new Map<string, Set<T>>(),
    LensModel: new Map<string, Set<T>>(),
    FocalLength: new Map<string, Set<T>>(),
    Aperture: new Map<string, Set<T>>(),
    ShutterSpeed: new Map<string, Set<T>>(),
    ISO: new Map<string, Set<T>>(),
}) as const;

export type Indexes<T> = ReturnType<typeof makeIndexes<T>>;