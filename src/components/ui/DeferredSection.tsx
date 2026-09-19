import { useEffect, useState, type ReactNode } from "react";

interface DeferredSectionProps {
  id: string;
  children: ReactNode;
}

export default function DeferredSection({ id, children }: DeferredSectionProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const element = document.getElementById(id);
    if (!element) return;

    if (!("IntersectionObserver" in window)) {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setIsVisible(true);
        observer.disconnect();
      },
      { rootMargin: "200px 0px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [id]);

  return (
    <div id={id} className="min-h-[420px]">
      {isVisible ? children : <div aria-hidden="true" />}
    </div>
  );
}
