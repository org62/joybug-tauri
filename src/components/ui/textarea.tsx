import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const textareaVariants = cva(
  "placeholder:text-muted-foreground border-input dark:bg-input/30 flex w-full min-w-0 rounded-md border bg-transparent shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  {
    variants: {
      textareaSize: {
        default: "px-3 py-2 text-base md:text-sm",
        // Dense panel control, matches Input inputSize="xs".
        xs: "px-2 py-1 text-xs",
      },
    },
    defaultVariants: {
      textareaSize: "default",
    },
  }
)

export interface TextareaProps
  extends React.ComponentProps<"textarea">,
    VariantProps<typeof textareaVariants> {}

function Textarea({ className, textareaSize, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(textareaVariants({ textareaSize, className }))}
      {...props}
    />
  )
}

export { Textarea, textareaVariants }
