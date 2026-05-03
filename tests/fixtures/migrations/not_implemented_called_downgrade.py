"""Migration whose downgrade raises NotImplementedError(...)."""

revision = "005"
down_revision = "004"


def upgrade():
    op.alter_column("orders", "discount_pct", nullable=False)


def downgrade():
    """No supported reverse path."""
    raise NotImplementedError("downgrade not supported")
