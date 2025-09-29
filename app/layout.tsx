import "./globals.css";

export const metadata = {
  title: "Nevola Trading",
  description: "Demo de Trading en Next.js + Tailwind",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
