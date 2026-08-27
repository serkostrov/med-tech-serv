import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils.js";

const EMPTY_VALUE = "__empty__";

export function isSelectSurface(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-select-surface]"));
}

interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

function optionLabel(children: React.ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(optionLabel).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(children)) return optionLabel(children.props.children);
  return "";
}

function collectOptions(children: React.ReactNode): SelectOption[] {
  const options: SelectOption[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement<{ value?: string | number; disabled?: boolean; children?: React.ReactNode }>(child)) return;
    if (child.type !== "option") return;
    const label = optionLabel(child.props.children);
    const value = child.props.value === undefined ? label : String(child.props.value);
    options.push({
      value,
      label,
      ...(child.props.disabled ? { disabled: true } : {})
    });
  });
  return options;
}

function toRadixValue(value: string): string {
  return value === "" ? EMPTY_VALUE : value;
}

function fromRadixValue(value: string): string {
  return value === EMPTY_VALUE ? "" : value;
}

export type SelectProps = Omit<React.ComponentPropsWithoutRef<"select">, "size"> & {
  readonly children?: React.ReactNode;
};

const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      children,
      className,
      value,
      defaultValue,
      onChange,
      name,
      required,
      disabled,
      id,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy
    },
    ref
  ) => {
    const options = React.useMemo(() => collectOptions(children), [children]);
    const isControlled = value !== undefined;
    const [uncontrolled, setUncontrolled] = React.useState(() => String(defaultValue ?? ""));
    const requested = isControlled ? String(value) : uncontrolled;
    const matched = options.find((option) => option.value === requested);
    const fallback = matched ? undefined : options.find((option) => !option.disabled) ?? options[0];
    const current = matched?.value ?? fallback?.value ?? requested;

    React.useEffect(() => {
      if (isControlled || matched || !fallback || fallback.value === uncontrolled) return;
      setUncontrolled(fallback.value);
    }, [fallback, isControlled, matched, uncontrolled]);

    const emitChange = (next: string) => {
      if (!isControlled) setUncontrolled(next);
      onChange?.({
        target: { value: next, name: name ?? "" },
        currentTarget: { value: next, name: name ?? "" }
      } as React.ChangeEvent<HTMLSelectElement>);
    };

    return (
      <div className={cn("ui-select", className)}>
        {(name || required) ? (
          <select
            aria-hidden="true"
            className="ui-select__native"
            disabled={disabled}
            id={id ? `${id}-native` : undefined}
            name={name}
            required={required}
            tabIndex={-1}
            value={current}
            onChange={() => undefined}
          >
            {options.map((option) => (
              <option disabled={option.disabled} key={`native-${option.value || EMPTY_VALUE}`} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        <SelectPrimitive.Root
          disabled={disabled || options.length === 0}
          onValueChange={(next) => emitChange(fromRadixValue(next))}
          value={toRadixValue(current)}
        >
          <SelectPrimitive.Trigger
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            className="ui-select__trigger"
            data-select-surface=""
            id={id}
            ref={ref}
          >
            <SelectPrimitive.Value placeholder="Выберите…" />
            <SelectPrimitive.Icon asChild>
              <ChevronDown aria-hidden="true" className="ui-select__chevron" size={15} />
            </SelectPrimitive.Icon>
          </SelectPrimitive.Trigger>
          <SelectPrimitive.Portal>
            <SelectPrimitive.Content
              className="ui-select__content"
              collisionPadding={12}
              data-select-surface=""
              position="popper"
              sideOffset={6}
            >
              <SelectPrimitive.Viewport className="ui-select__viewport">
                {options.map((option) => (
                  <SelectPrimitive.Item
                    className="ui-select__item"
                    disabled={option.disabled}
                    key={option.value || EMPTY_VALUE}
                    value={toRadixValue(option.value)}
                  >
                    <span className="ui-select__item-indicator">
                      <SelectPrimitive.ItemIndicator>
                        <Check aria-hidden="true" size={14} />
                      </SelectPrimitive.ItemIndicator>
                    </span>
                    <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.Viewport>
            </SelectPrimitive.Content>
          </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
      </div>
    );
  }
);
Select.displayName = "Select";

export { Select };
