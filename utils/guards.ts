export const hasProperty = <Obj, Prop extends string>(obj: Obj, prop: Prop)
  : obj is Obj & Record<Prop, unknown> =>
  typeof obj === 'object' && obj !== null && prop in obj;