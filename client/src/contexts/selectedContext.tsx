import { createContext, useContext, useReducer } from "react";

const dispatchActions = {
    'add': (state: Set<string>, payload: string) => {
        return new Set(state).add(payload);
    },
    'toggle': (state: Set<string>, payload: string) => {
        const newState = new Set(state);
        if (newState.has(payload)) {
            newState.delete(payload);
        } else {
            newState.add(payload);
        }
        return newState;
    },
    'addMultiple': (state: Set<string>, payload: Set<string>) => {
        const newState = new Set(state);
        return newState.intersection(payload);
    },
    'set': (_: Set<string>, payload: Set<string>) => {
        return new Set(payload);
    },
    'remove': (_: Set<string>, payload: string) => {
        const newState = new Set();
        newState.delete(payload);
        return newState;
    },
    'clear': () => {
        return new Set<string>();
    }
} as const

type DispatchActions = typeof dispatchActions;

const selectedReducer = <T extends keyof DispatchActions>(state: Set<string>, action: { type: T; payload?: Parameters<DispatchActions[T]>[1] }) => {
    const { type, payload } = action;
    return dispatchActions[type](state, payload as any);
}

const SelectedContext = createContext(new Set<string>());
const SelectedDispatchContext = createContext<React.Dispatch<{ type: keyof typeof dispatchActions; payload?: string | Set<string> }>>(() => {});

export const SelectedProvider = ({ children }: { children: React.ReactNode }) => {
    const [selected, dispatch] = useReducer(selectedReducer, new Set<string>());

    return (
        <SelectedContext.Provider value={selected}>
            <SelectedDispatchContext.Provider value={dispatch}>
                {children}
            </SelectedDispatchContext.Provider>
        </SelectedContext.Provider>
    );
}

export const useSelected = () => useContext(SelectedContext);
export const useSelectedDispatch = () => useContext(SelectedDispatchContext);