window.data = new Map();

export const QQQ = (segments, ...values)=>{
    values.map((value, index)=>{
        if (typeof value === 'function') {
            values[index] = value.toString();
        }
        if (Array.isArray(value) && value[0] === QQQ) {
            value[1];
        }
    });
}

export const RRR = (label)=>{
    return [QQQ, label]
}