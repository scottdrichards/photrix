export  const dateRangeToNumberRange = (
    {from,to}: { from?: Date; to?: Date },
) => ({
        ... (from?{from: from.getTime()}:{}),
        ...(to?{to: to.getTime()}:{}),
    })