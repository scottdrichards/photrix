export const conversionPriorityList = ["userBlocked", "userImplicit", "background"] as const;
export type ConversionPriority = (typeof conversionPriorityList)[number];
