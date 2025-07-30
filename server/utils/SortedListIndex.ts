
export class SortedListIndex <T>{
    private sortedList: Array<[number,T[]]> = [];
    private getIndex(sortValue: number): number {
        // Binary search to find the index of the value
        let low = 0;
        let high = this.sortedList.length - 1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (this.sortedList[mid][0] < sortValue) {
                low = mid + 1;
            } else if (this.sortedList[mid][0] > sortValue) {
                high = mid - 1;
            } else {
                return mid; // number found
            }
        }
        return low; // Return the index where the entry should be inserted
    }
    public add(sortValue: number, item: T) {
        const index = this.getIndex(sortValue);
        if (this.sortedList[index] && this.sortedList[index][0] === sortValue) {
            if (Array.isArray(this.sortedList[index][1])) {
                this.sortedList[index][1].push(item);
            } else {
                this.sortedList[index][1] = [this.sortedList[index][1], item];
            }
            return;
        }
        this.sortedList.splice(index, 0, [sortValue, [item]]);
    }        

    public *getBetween({ from, to }: { from?: number; to?: number }): Generator<T> {
        const startIndex = from ? this.getIndex(from) : 0;
        const endIndex = to ? this.getIndex(to) : this.sortedList.length;
        for (let i = startIndex; i < endIndex; i++) {
            const [_, item] = this.sortedList[i];
            if (Array.isArray(item)) {
                for (const f of item) {
                    yield f;
                }
            } else {
                yield item;
            }
        }
    }
}