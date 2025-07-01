import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Menu } from "lucide-react";

const navigationItems = [
  { name: "Debugger", path: "/debugger" },
  { name: "RcDock", path: "/rcdock" },
  { name: "Logs", path: "/logs" },
  { name: "Settings", path: "/settings" },
  { name: "About", path: "/about" },
  { name: "Debugger Example", path: "/debugger-example" },
];

export default function Header() {
  const location = useLocation();

  const NavLinks = ({ mobile = false }: { mobile?: boolean }) => (
    <>
      {navigationItems.map((item) => (
        <Link
          key={item.path}
          to={item.path}
          className={`${
            location.pathname === item.path
              ? "text-blue-600 dark:text-amber-400 font-medium"
              : "text-gray-600 dark:text-neutral-300 hover:text-gray-900 dark:hover:text-neutral-100"
          } ${mobile ? "block py-2" : ""} transition-colors`}
        >
          {item.name}
        </Link>
      ))}
    </>
  );

  return (
    <header
      className="border-b bg-white dark:bg-neutral-800 shadow-sm"
      data-tauri-drag-region
    >
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        <div className="flex items-center space-x-8">
          <Link
            to="/"
            data-tauri-drag-region="none"
            className="font-bold text-xl text-gray-900 dark:text-neutral-100"
          >
            Joybug
          </Link>
          
          {/* Desktop Navigation */}
          <nav className="hidden md:flex space-x-6" data-tauri-drag-region="none">
            <NavLinks />
          </nav>
        </div>

        {/* Mobile Navigation */}
        <div className="md:hidden">
          <Sheet>
            <SheetTrigger asChild data-tauri-drag-region="none">
              <Button variant="ghost" size="sm" data-tauri-drag-region="none">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <nav className="mt-6 space-y-1">
                <NavLinks mobile />
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
} 