"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/** Botão de enviar que fica ocupado enquanto a Server Action roda. */
export function Enviar({
  children,
  ocupado,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "type"> & { ocupado?: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || props.disabled} aria-busy={pending} {...props}>
      {pending ? (ocupado ?? children) : children}
    </Button>
  );
}
