declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react'

  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'
  export function Button(props: {
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement

  export function Input(props: {
    icon?: ReactNode
    className?: string
  } & InputHTMLAttributes<HTMLInputElement>): ReactElement

  export function DisclosureRow(props: {
    icon: ReactNode
    title: string
    open: boolean
    expandable: boolean
    onToggle: () => void
    expandOnRowClick?: boolean
    previewChevron?: boolean
    collapsedContent?: ReactNode
    children?: ReactNode
    className?: string
    rowClassName?: string
    titleClassName?: string
  }): ReactElement

  export function StateDot(props: {
    state: 'done' | 'warning' | 'ongoing' | 'error'
    size?: number
    className?: string
  }): ReactElement

  export function IconCheckOutline16(props: { size?: number; className?: string }): ReactElement
  export function IconChevronDownOutline14(props: { size?: number; className?: string }): ReactElement
  export function IconChevronUpOutline14(props: { size?: number; className?: string }): ReactElement
  export function IconLinkOutline14(props: { size?: number; className?: string }): ReactElement
  export function IconRefreshOutline14(props: { size?: number; className?: string }): ReactElement
}
