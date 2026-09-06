import { useCallback, useRef, useState } from "react";

/** Keep asynchronous document updates aware of choices not yet resolved, even
 * between a save response and React's next render. */
export function useAssignmentConflictKeys() {
  const [keys, setState] = useState<string[]>([]);
  const keysRef = useRef(keys);
  const setKeys = useCallback((next: string[]) => {
    keysRef.current = next;
    setState(next);
  }, []);
  return [keys, setKeys, keysRef] as const;
}
