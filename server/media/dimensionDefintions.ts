export type Dimensions = {
    width: number,
    height: number,
}

export const sizes = [
    ['small', {width:100, height:100}],
    ['medium', {width:200, height:200}],
    ['large', {width:400, height:400}],
    ['extraLarge', {width:800, height:800}],
    ['full', {width:1600, height:1600}],
 ] as const satisfies [string, Dimensions][];

 type SizeLabels = typeof sizes[number][0] | 'original';


 export const getSizeLabel = (desired:Dimensions | {}):SizeLabels=>{
    if (!('width' in desired && 'height' in desired)){
        return 'original';
    }
    return sizes.find(([label, {width,height}])=>
        width>=desired.width && height>=desired.height)?.[0] ??
        'original';
 }

 export const isThumbnail = (desired:Dimensions | {}):desired is Dimensions=>{
    return getSizeLabel(desired)!=='original';
 }
 
export const getNearestSize = (desired:Dimensions | {}):Dimensions|{}=>{
    const label = getSizeLabel(desired);
    return sizes.find(([l])=>l===label)?.[1] ?? {width:undefined, height:undefined};
}