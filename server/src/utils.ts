
export type AssertNever<T extends never> = T;

export type UnionXOR<A, B> = Exclude<A, B> | Exclude<B, A>;