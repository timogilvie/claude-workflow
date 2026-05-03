def upgrade():
    op.drop_column("users", "nickname")


def downgrade():
    op.add_column("users", sa.Column("nickname", sa.String(), nullable=True))
