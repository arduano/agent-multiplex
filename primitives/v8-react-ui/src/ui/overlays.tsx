/* Adapted from shadcn/ui (MIT). Exact source and license: ../../build/shadcn.
 * Portal custody is explicit: no fallback to document.body or ambient theme. */
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from './utils.js';
import type { DataAttributes } from './controls.js';

type PortalScope = DataAttributes & {container: HTMLElement | null};
export const Dialog = DialogPrimitive.Root, DialogTrigger = DialogPrimitive.Trigger, DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title, DialogDescription = DialogPrimitive.Description;
export const DialogContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & PortalScope>(function DialogContent({container, className, children, ...props}, ref) {
  if (!container) return null;
  return <DialogPrimitive.Portal container={container}><DialogPrimitive.Overlay className="mpx-ui-overlay" /><DialogPrimitive.Content ref={ref} className={cn('mpx-ui-dialog', className)} {...props}>{children}</DialogPrimitive.Content></DialogPrimitive.Portal>;
});
export const Sheet = Dialog, SheetTrigger = DialogTrigger, SheetClose = DialogClose, SheetTitle = DialogTitle, SheetDescription = DialogDescription;
export const SheetContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & PortalScope>(function SheetContent({className, ...props}, ref) {
  return <DialogContent ref={ref} className={cn('mpx-ui-sheet',className)} {...props} />;
});
export const Popover = PopoverPrimitive.Root, PopoverTrigger = PopoverPrimitive.Trigger, PopoverClose = PopoverPrimitive.Close, PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverContent = React.forwardRef<React.ComponentRef<typeof PopoverPrimitive.Content>, React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & PortalScope>(function PopoverContent({container, className, align = 'start', sideOffset = 8, collisionPadding = 12, collisionBoundary = container, ...props}, ref) {
  if (!container) return null;
  return <PopoverPrimitive.Portal container={container}><PopoverPrimitive.Content ref={ref} align={align} sideOffset={sideOffset} collisionPadding={collisionPadding} collisionBoundary={collisionBoundary} className={cn('mpx-ui-popover', className)} {...props} /></PopoverPrimitive.Portal>;
});
export const DropdownMenu = MenuPrimitive.Root, DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuContent = React.forwardRef<React.ComponentRef<typeof MenuPrimitive.Content>, React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content> & PortalScope>(function DropdownMenuContent({container, className, sideOffset = 8, collisionPadding = 12, collisionBoundary = container, ...props}, ref) {
  if (!container) return null;
  return <MenuPrimitive.Portal container={container}><MenuPrimitive.Content ref={ref} sideOffset={sideOffset} collisionPadding={collisionPadding} collisionBoundary={collisionBoundary} className={cn('mpx-ui-menu',className)} {...props} /></MenuPrimitive.Portal>;
});
export const DropdownMenuItem = React.forwardRef<React.ComponentRef<typeof MenuPrimitive.Item>, React.ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & DataAttributes>(function DropdownMenuItem({className, ...props}, ref) {
  return <MenuPrimitive.Item ref={ref} className={cn('mpx-ui-menu-item',className)} {...props} />;
});
export const DropdownMenuSeparator = MenuPrimitive.Separator;
export const Tabs = TabsPrimitive.Root;
export const TabsList = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.List>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(function TabsList({className,...props}, ref) {return <TabsPrimitive.List ref={ref} className={cn('mpx-ui-tabs',className)} {...props}/>;});
export const TabsTrigger = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(function TabsTrigger({className,...props}, ref) {return <TabsPrimitive.Trigger ref={ref} className={cn('mpx-ui-tab',className)} {...props}/>;});
export const TabsContent = TabsPrimitive.Content;
export const TooltipProvider = TooltipPrimitive.Provider, Tooltip = TooltipPrimitive.Root, TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipContent = React.forwardRef<React.ComponentRef<typeof TooltipPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & PortalScope>(function TooltipContent({container,className,sideOffset = 6,collisionBoundary = container,...props},ref){
  if(!container)return null;
  return <TooltipPrimitive.Portal container={container}><TooltipPrimitive.Content ref={ref} sideOffset={sideOffset} collisionBoundary={collisionBoundary} className={cn('mpx-ui-tooltip',className)} {...props}/></TooltipPrimitive.Portal>;
});
