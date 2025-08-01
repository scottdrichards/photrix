export  const dateRangeToNumberRange = (
    {from,to}: { from?: Date | string; to?: Date|string },
) => ({
        ... (from?{from: new Date(from).getTime()}:{}),
        ...(to?{to: new Date(to).getTime()}:{}),
    })