import type { Entity, GeneratedFile, StackConfig } from "../types";
import { safeName, toSnake } from "../types";

/**
 * Emits a Go gRPC server skeleton. Assumes the user runs `make proto` once
 * after cloning to produce the generated stubs under `gen/go/`. We deliberately
 * do NOT commit generated code from Helios — users regenerate from their own
 * proto edits, and committing stale generated Go into every Helios zip would
 * be noise.
 */
export function goGrpcFiles(
  config: StackConfig,
  entities: Entity[]
): GeneratedFile[] {
  const name = safeName(config.name);
  const module = `github.com/your-org/${name}`;
  const pkg = name.replace(/-/g, "_") + "v1";
  const pkgPath = `${module}/gen/go/${name.replace(/-/g, "_")}/v1`;

  const files: GeneratedFile[] = [];

  files.push({
    path: "cmd/api/main.go",
    content: goGrpcMain(module, pkg, pkgPath, entities),
  });

  files.push({
    path: "internal/grpcserver/server.go",
    content: goGrpcServer(pkg, pkgPath, entities),
  });

  for (const entity of entities) {
    files.push({
      path: `internal/grpcserver/${toSnake(entity.name)}_service.go`,
      content: goGrpcEntityService(pkg, pkgPath, entity),
    });
  }

  files.push({
    path: "internal/grpcserver/health.go",
    content: goGrpcHealth(),
  });

  files.push({
    path: "go.mod",
    content: goGrpcMod(module, entities.length > 0),
  });

  return files;
}

function goGrpcMod(module: string, hasEntities: boolean): string {
  const db = hasEntities
    ? `\tgorm.io/driver/postgres v1.5.11\n\tgorm.io/gorm v1.25.12\n`
    : "";
  return `module ${module}

go 1.23

require (
\tgoogle.golang.org/grpc v1.68.1
\tgoogle.golang.org/grpc/cmd/protoc-gen-go-grpc v1.5.1
\tgoogle.golang.org/protobuf v1.36.1
${db}\tgithub.com/prometheus/client_golang v1.20.5
)
`;
}

function goGrpcMain(module: string, pkg: string, pkgPath: string, entities: Entity[]): string {
  const imports = [
    `"context"`,
    `"log"`,
    `"net"`,
    `"os"`,
    `"os/signal"`,
    `"syscall"`,
    ``,
    `"google.golang.org/grpc"`,
    `"google.golang.org/grpc/health"`,
    `healthpb "google.golang.org/grpc/health/grpc_health_v1"`,
    `"google.golang.org/grpc/reflection"`,
    ``,
    `pb "${pkgPath}"`,
    `"${module}/internal/grpcserver"`,
  ].join("\n\t");

  const registrations = entities
    .map((e) => `\tpb.Register${e.name}ServiceServer(grpcSrv, grpcserver.New${e.name}Service())`)
    .join("\n");

  return `package main

import (
\t${imports}
)

func main() {
\taddr := ":" + getenv("PORT", "8080")
\tlis, err := net.Listen("tcp", addr)
\tif err != nil {
\t\tlog.Fatalf("listen: %v", err)
\t}

\tgrpcSrv := grpc.NewServer()

${registrations}

\t// Standard gRPC health service — probes use grpc-health-probe or
\t// the grpc.health.v1.Health endpoint.
\thealthSrv := health.NewServer()
\thealthpb.RegisterHealthServer(grpcSrv, healthSrv)
\thealthSrv.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

\t// Server reflection makes tools like grpcurl / bloomrpc work without a proto file.
\treflection.Register(grpcSrv)

\tlog.Printf("gRPC server listening on %s", addr)

\tgo func() {
\t\tif err := grpcSrv.Serve(lis); err != nil {
\t\t\tlog.Fatalf("serve: %v", err)
\t\t}
\t}()

\tctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
\tdefer stop()
\t<-ctx.Done()

\tlog.Println("shutdown requested; draining connections")
\thealthSrv.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)
\tgrpcSrv.GracefulStop()
}

func getenv(k, def string) string {
\tif v := os.Getenv(k); v != "" {
\t\treturn v
\t}
\treturn def
}
`;
}

function goGrpcServer(pkg: string, pkgPath: string, entities: Entity[]): string {
  return `package grpcserver

// This package holds one server type per entity service. Each server embeds
// the generated \`Unimplemented<Entity>ServiceServer\` so that future proto
// additions don't break the build — unimplemented RPCs return
// \`codes.Unimplemented\` until you fill them in.
//
// Wire a real database (gorm / sqlx / pgx) in place of the TODO stubs.

import (
\t_ "${pkgPath}"
)
`;
}

function goGrpcEntityService(pkg: string, pkgPath: string, entity: Entity): string {
  const name = entity.name;
  return `package grpcserver

import (
\t"context"

\t"google.golang.org/grpc/codes"
\t"google.golang.org/grpc/status"
\t"google.golang.org/protobuf/types/known/emptypb"

\tpb "${pkgPath}"
)

// ${name}Service implements pb.${name}ServiceServer.
//
// The stubs below return \`Unimplemented\` — replace each with real data-layer
// calls (gorm repository, sqlx queries, etc). Signatures are fixed by the
// generated proto; do not rename them.
type ${name}Service struct {
\tpb.Unimplemented${name}ServiceServer
}

func New${name}Service() *${name}Service {
\treturn &${name}Service{}
}

func (s *${name}Service) List${name}(ctx context.Context, req *pb.List${name}Request) (*pb.List${name}Response, error) {
\treturn nil, status.Errorf(codes.Unimplemented, "List${name} not implemented")
}

func (s *${name}Service) Get${name}(ctx context.Context, req *pb.Get${name}Request) (*pb.${name}, error) {
\treturn nil, status.Errorf(codes.Unimplemented, "Get${name} not implemented")
}

func (s *${name}Service) Create${name}(ctx context.Context, req *pb.Create${name}Request) (*pb.${name}, error) {
\treturn nil, status.Errorf(codes.Unimplemented, "Create${name} not implemented")
}

func (s *${name}Service) Update${name}(ctx context.Context, req *pb.Update${name}Request) (*pb.${name}, error) {
\treturn nil, status.Errorf(codes.Unimplemented, "Update${name} not implemented")
}

func (s *${name}Service) Delete${name}(ctx context.Context, req *pb.Delete${name}Request) (*emptypb.Empty, error) {
\treturn nil, status.Errorf(codes.Unimplemented, "Delete${name} not implemented")
}
`;
}

function goGrpcHealth(): string {
  return `package grpcserver

// The standard grpc.health.v1.Health service is registered in cmd/api/main.go.
// This file is a placeholder for liveness/readiness helpers you may want to
// expose separately (e.g. checking DB connectivity before reporting SERVING).
`;
}
