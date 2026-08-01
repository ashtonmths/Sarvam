"use client";

import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";

type Option = { value: string; label: string };

/**
 * The app's only dropdown. Radix supplies the behavior — portal, collision
 * aware positioning, typeahead, aria wiring — and the design system supplies
 * every pixel, so native select arrows never fight our border box again.
 */
export function Select({
  value,
  defaultValue,
  onChange,
  options,
  label,
  id,
  small,
  testid,
}: {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  options: Option[];
  label?: string;
  id?: string;
  small?: boolean;
  testid?: string;
}) {
  return (
    <RadixSelect.Root
      value={value}
      defaultValue={defaultValue ?? (value === undefined ? options[0]?.value : undefined)}
      onValueChange={onChange}
    >
      <RadixSelect.Trigger
        id={id}
        className={`select__btn${small ? " select__btn--small" : ""}`}
        aria-label={label}
        data-testid={testid}
      >
        <RadixSelect.Value />
        <RadixSelect.Icon className="select__chevron">
          <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          className="select__menu"
          position="popper"
          sideOffset={6}
          collisionPadding={12}
        >
          <RadixSelect.Viewport className="select__viewport">
            {options.map((opt) => (
              <RadixSelect.Item key={opt.value} value={opt.value} className="select__opt">
                <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="select__check">
                  <Check size={14} strokeWidth={1.8} aria-hidden="true" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
