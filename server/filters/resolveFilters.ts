import type { Filter } from "./filterType";

/**
 * It must pass every filter or validator to be included in the result. Returns an iterable so as to allow the caller
 * to prioritize when to stop or continue iterating.
 */
export const resolveFilters = <T>(filters: Array<Filter<T>>): IterableIterator<T> => {
    if (!filters.some(f=>f.set || f.generator)){
        throw new Error("No starting point to filter out (i.e., no set or generator provided)");
    }

    // First organize the filter results by their capabilities.
    const {hasSet, generatorAndValidator, onlyGenerator, onlyValidator} = Object.groupBy(filters, (f) => {
        if (f.set) {
            return "hasSet";
        };
        if (f.generator && f.validator){
            return "generatorAndValidator";
        }
        if (f.generator) {
            return "onlyGenerator";
        }
        if (f.validator) {
            return "onlyValidator";
        }
        throw new Error("Filter must have at least one of set, generator or validator");
    }) as {
        hasSet?: Pick<Required<Filter<T>>, 'set'>[];
        onlyGenerator?: Pick<Required<Filter<T>>, 'generator'>[];
        generatorAndValidator?: Pick<Required<Filter<T>>, 'generator' | 'validator'>[];
        onlyValidator?: Pick<Required<Filter<T>>, 'validator'>[];
    };

    // Now only take advantage of having a single generator, so we convert all other generators to sets.
    // ⏩We currently have no metric for sorting generators by estimated size or efficiency. 
    const [firstOnlyGenerator, ...generatorsToConvertToSets] = (onlyGenerator?.map(f => f.generator) ?? []) as  (Generator<T, any, any> | undefined)[];

    // ⏩This could be slow if the generators are large! If a set(from hasSet or this converted) - we may wish to 
    // end early and not make sets from generators
    const generatorSets = generatorsToConvertToSets.map(g => new Set(g));

    const allSets = [...hasSet?.map(s => s.set) ?? [], ...generatorSets]
        .sort((a, b) => a.size - b.size); // Ensure we start with the smallest set for efficiency.

    const allValidators = [...onlyValidator||[], ...generatorAndValidator||[]].map(f => f.validator);

    // So here we have a connundrum: we don't know how big/long the generator/validator will be. It might be 3 items, it might be 3000.
    // So we have to guess how to handle this variability.

    const startingItems = firstOnlyGenerator || allSets[0]?.values() || generatorAndValidator?.at(0);

    // ⏩ If we took the generator from generatorAndValidator or allSets, we still validate it against the same set/validator.
    // This likely isn't worth the complexity of separating them out.
    return startingItems.filter(item =>  allSets.every(s => s.has(item)) && allValidators.every(v => v(item)));
}
