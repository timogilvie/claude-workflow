"""Migration with a real downgrade implementation."""

revision = "007"
down_revision = "006"


def upgrade():
    op.add_column("widgets", "label")


def downgrade():
    op.drop_column("widgets", "label")
