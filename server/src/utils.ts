
// Source - https://stackoverflow.com/a/50375286
// Posted by jcalz, modified by community. See post 'Timeline' for change history
// Retrieved 2025-11-07, License - CC BY-SA 4.0
export type UnionToIntersection<U> = 
  (U extends unknown ? (x: U)=>void : never) extends ((x: infer I)=>void) ? I : never
