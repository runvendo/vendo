const apiSurface = [
  "POST /api/login",
  "GET, POST /api/invoices",
  "GET, PATCH, DELETE /api/invoices/:id",
  "POST /api/invoices/:id/send",
  "GET /api/invoices/archive",
  "GET /api/customers",
];

export default function HomePage() {
  return (
    <main>
      <h1>Seeded invoice fixture</h1>
      <p>Sign in through the login endpoint, then exercise the deterministic API.</p>
      <ul>
        {apiSurface.map((route) => (
          <li key={route}>{route}</li>
        ))}
      </ul>
    </main>
  );
}
