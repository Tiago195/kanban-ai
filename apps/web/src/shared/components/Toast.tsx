import { useToastStore } from "@/shared/services/toastStore";

export function Toast() {
  const message = useToastStore((state) => state.message);
  return <div className={"toast" + (message ? " show" : "")}>{message}</div>;
}
