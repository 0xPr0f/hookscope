import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Check, ChevronDown } from 'lucide-react'

export type AppDropdownOption<Value extends string | number> = {
  value: Value
  label: string
  description?: string
  icon?: ReactNode
}

type DropdownStyle = CSSProperties & {
  '--app-dropdown-menu-width'?: string
  '--app-dropdown-menu-max-height'?: string
}

/**
 * App-wide accessible listbox.
 *
 * The menu is always bounded by this component's own width. `menuWidth` can
 * make it narrower, but CSS `min(100%, …)` prevents a menu from spilling into
 * a neighbouring form control or beyond its containing panel.
 */
export function AppDropdown<Value extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  density = 'standard',
  menuWidth = '100%',
  menuMaxHeight = 320,
  className = '',
}: {
  value: Value
  options: readonly AppDropdownOption<Value>[]
  onChange: (value: Value) => void
  ariaLabel: string
  disabled?: boolean
  density?: 'standard' | 'compact'
  /** A CSS width or pixel width; it is clamped to the trigger container. */
  menuWidth?: number | string
  menuMaxHeight?: number
  className?: string
}) {
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const selected = options[selectedIndex]
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const style = useMemo<DropdownStyle>(() => ({
    '--app-dropdown-menu-width': typeof menuWidth === 'number' ? `${Math.max(1, menuWidth)}px` : menuWidth,
    '--app-dropdown-menu-max-height': `${Math.max(96, menuMaxHeight)}px`,
  }), [menuMaxHeight, menuWidth])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  const choose = (index: number) => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    setActiveIndex(index)
    setOpen(false)
  }

  const move = (direction: 1 | -1) => {
    if (!options.length) return
    setActiveIndex((current) => (current + direction + options.length) % options.length)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActiveIndex(selectedIndex)
      } else {
        move(event.key === 'ArrowDown' ? 1 : -1)
      }
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!open) return
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? 0 : options.length - 1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) choose(activeIndex)
      else setOpen(true)
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    }
  }

  if (!selected) return null

  return (
    <div className={`app-dropdown app-dropdown-${density} ${open ? 'open' : ''} ${className}`.trim()} ref={rootRef} style={style}>
      <button
        type="button"
        className="app-dropdown-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => {
          setActiveIndex(selectedIndex)
          setOpen((current) => !current)
        }}
        onKeyDown={handleKeyDown}
      >
        {selected.icon && <span className="app-dropdown-icon" aria-hidden="true">{selected.icon}</span>}
        <span className="app-dropdown-copy"><strong>{selected.label}</strong>{selected.description && <small>{selected.description}</small>}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="app-dropdown-menu" id={listboxId} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              type="button"
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={option.value === selected.value}
              className={index === activeIndex ? 'active' : ''}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => choose(index)}
              key={option.value}
            >
              {option.icon && <span className="app-dropdown-icon" aria-hidden="true">{option.icon}</span>}
              <span className="app-dropdown-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              {option.value === selected.value && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
